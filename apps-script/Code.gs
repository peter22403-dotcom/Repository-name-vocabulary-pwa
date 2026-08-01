/*************************************************************
 * 國中會考閱讀助手 — Google Apps Script 後端
 * 功能：
 *   1) 代打 Gemini（金鑰藏在這裡，不會外洩到公開網頁）
 *   2) 生字本 / 閱讀紀錄存到這份 Google Sheet
 *
 * 部署前你只要做一件事：
 *   Apps Script 左邊「專案設定」→「指令碼屬性」→ 新增：
 *     屬性名稱：GEMINI_API_KEY   值：你的 Gemini 金鑰
 *   （可選）MODEL  值：gemini-2.5-flash   ← 不填就用預設
 *
 * 然後「部署」→「新增部署作業」→ 類型選「網頁應用程式」
 *   執行身分：我自己
 *   誰可以存取：任何人
 * 複製產生的網址，貼進 reading.html 的設定。
 *************************************************************/

var DEFAULT_MODEL = 'gemini-2.5-flash';

// ---- 入口 ----------------------------------------------------
function doGet(e) {
  // 讓你可以用瀏覽器直接打開網址測試是否活著
  return json_({ ok: true, msg: '閱讀助手後端運作中 ✅' });
}

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents || '{}');
    var action = req.action || '';
    var data;

    switch (action) {
      case 'generateArticle': data = generateArticle_(req); break;
      case 'explainWord':     data = explainWord_(req);     break;
      case 'explainQuiz':     data = explainQuiz_(req);     break;
      case 'saveVocab':       data = saveVocab_(req);       break;
      case 'loadVocab':       data = loadVocab_(req);       break;
      case 'updateVocab':     data = updateVocab_(req);     break;
      case 'saveReadingLog':  data = saveReadingLog_(req);  break;
      case 'loadReadingLog':  data = loadReadingLog_(req);  break;
      case 'makeQuiz':        data = makeQuiz_(req);        break;
      case 'translate':       data = translate_(req);       break;
      case 'checkIn':         data = checkIn_(req);         break;
      case 'loadChecks':      data = loadChecks_(req);      break;
      default: throw new Error('未知的 action: ' + action);
    }
    return json_({ ok: true, data: data });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// ---- Gemini 呼叫 --------------------------------------------
function callGemini_(prompt, expectJson) {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('尚未設定 GEMINI_API_KEY（到「專案設定 → 指令碼屬性」新增）');
  var model = PropertiesService.getScriptProperties().getProperty('MODEL') || DEFAULT_MODEL;

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
            model + ':generateContent?key=' + encodeURIComponent(key);

  var body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7 }
  };
  if (expectJson) body.generationConfig.responseMimeType = 'application/json';

  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code !== 200) throw new Error('Gemini 回應錯誤 (' + code + '): ' + text.slice(0, 400));

  var out = JSON.parse(text);
  var parts = out && out.candidates && out.candidates[0] &&
              out.candidates[0].content && out.candidates[0].content.parts;
  if (!parts || !parts[0]) throw new Error('Gemini 沒有回傳內容');
  var content = parts.map(function (p) { return p.text || ''; }).join('');

  if (expectJson) return safeParseJson_(content);
  return content;
}

function safeParseJson_(s) {
  try { return JSON.parse(s); } catch (e) {}
  // 去掉可能的 ```json 圍欄
  var m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e2) {} }
  throw new Error('無法解析 AI 回傳的 JSON');
}

// ---- 出文章 -------------------------------------------------
function generateArticle_(req) {
  var topic = req.topic || '日常生活';
  var length = req.length || '中'; // 短/中/長
  var wordCount = length === '短' ? '80-110' : (length === '長' ? '180-230' : '120-160');

  var prompt =
    '你是台灣國中英文老師，要幫「國中會考」程度的學生出一篇英文閱讀練習。\n' +
    '主題：' + topic + '。文章長度約 ' + wordCount + ' 個英文單字。\n' +
    '難度對準台灣國中會考（核心約 2000 字），句型不要太難，但可以放 4-8 個略有挑戰的單字。\n\n' +
    '請「只」回傳以下 JSON 結構（中文說明用繁體中文）：\n' +
    '{\n' +
    '  "title": "英文標題",\n' +
    '  "article": "英文文章本文（一段或數段，用 \\n 分段）",\n' +
    '  "glossary": [ {"word":"單字原型","pos":"詞性(n./v./adj.等)","zh":"中文意思","example":"用該字的簡單英文例句"} ],\n' +
    '  "grammar": [ {"point":"文法重點名稱","zh":"用繁體中文解釋這篇出現的文法","example":"文章中的英文例句"} ],\n' +
    '  "quiz": [ {"q":"英文題目","options":["A選項","B選項","C選項","D選項"],"answer":0,"zh":"繁體中文講解為什麼答案是它、其他選項錯在哪"} ]\n' +
    '}\n' +
    'glossary 放 6-10 個較難或關鍵的字。grammar 放 1-3 個重點。quiz 出 3-4 題（主旨/細節/猜字題型），answer 是正確選項的索引(0起算)。';

  var out = callGemini_(prompt, true);
  out.topic = topic;
  out.id = 'a' + Date.now();
  return out;
}

// ---- 點字查意思 ---------------------------------------------
function explainWord_(req) {
  var word = (req.word || '').trim();
  if (!word) throw new Error('沒有提供單字');
  var sentence = req.sentence || '';

  var prompt =
    '解釋英文單字給台灣國中生，用繁體中文。單字："' + word + '"。' +
    (sentence ? '它出現在這句：「' + sentence + '」，請依這個上下文解釋。' : '') +
    '只回傳 JSON：{"word":"原型","pos":"詞性","zh":"中文意思(簡短)","example":"一句簡單英文例句","note":"若有片語或用法提醒(沒有就空字串)"}';

  return callGemini_(prompt, true);
}

// ---- 逐題講解（作答後） -------------------------------------
function explainQuiz_(req) {
  var article = req.article || '';
  var items = req.items || []; // [{q, options, answer, chosen}]
  var prompt =
    '你是國中英文老師。以下是一篇文章與學生的作答，請用繁體中文逐題講解：說明正確答案為什麼對、學生選的為什麼錯、以及相關文法或字彙。\n' +
    '文章：\n' + article + '\n\n' +
    '題目與作答（JSON）：\n' + JSON.stringify(items) + '\n\n' +
    '只回傳 JSON：{"feedback":[{"q":"題目","correct":正確索引,"chosen":學生索引,"zh":"講解"}], "overall":"整體鼓勵與建議(繁體中文)"}';
  return callGemini_(prompt, true);
}

// ---- 用生字本出小考 ----------------------------------------
function makeQuiz_(req) {
  var words = req.words || []; // [{word, zh}]
  if (!words.length) throw new Error('生字本是空的');
  var prompt =
    '幫台灣國中生用他的生字做英文小考。生字清單(JSON)：' + JSON.stringify(words) + '\n' +
    '出' + Math.min(words.length, 10) + '題選擇題，題型混合(看英選中、看中選英、句子填空)。\n' +
    '只回傳 JSON：{"quiz":[{"q":"題目","options":["","","",""],"answer":正確索引,"word":"這題考的單字原型"}]}';
  return callGemini_(prompt, true);
}

// ---- 整段翻譯 -----------------------------------------------
function translate_(req) {
  var text = (req.text || '').trim();
  if (!text) throw new Error('沒有要翻譯的文字');
  var prompt =
    '把下面這段英文翻成通順、自然的繁體中文，給台灣國中生看。' +
    '只回傳翻譯後的中文，不要加任何說明、拼音或原文。\n\n英文：\n' + text;
  return { zh: callGemini_(prompt, false).trim() };
}

// ---- 每日閱讀打卡 -------------------------------------------
function checkSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName('DailyCheck');
  if (!sh) {
    sh = ss.insertSheet('DailyCheck');
    sh.appendRow(['日期', '孩子', '完成']);
  }
  return sh;
}

function checkIn_(req) {
  var child = req.child || '';
  var date = req.date || todayStr_();       // yyyy-mm-dd
  var done = req.done === false ? false : true;
  var sh = checkSheet_();
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (cellYmd_(values[i][0]) === date && String(values[i][1]) === child) {
      sh.getRange(i + 1, 3).setValue(done ? 'TRUE' : 'FALSE');
      return { date: date, done: done };
    }
  }
  sh.appendRow([date, child, done ? 'TRUE' : 'FALSE']);
  return { date: date, done: done };
}

function loadChecks_(req) {
  var child = req.child || '';
  var sh = checkSheet_();
  var values = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    if (!child || String(values[i][1]) === child) {
      out.push({ date: cellYmd_(values[i][0]), child: values[i][1],
                 done: String(values[i][2]).toUpperCase() === 'TRUE' });
    }
  }
  return { checks: out };
}

function todayStr_() {
  var tz = Session.getScriptTimeZone() || 'Asia/Taipei';
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}

// 把儲存格值（可能是 Date 物件或字串）統一轉成 yyyy-MM-dd
function cellYmd_(v) {
  if (v instanceof Date) {
    var tz = Session.getScriptTimeZone() || 'Asia/Taipei';
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  return String(v);
}

// ---- Sheets：生字本 ----------------------------------------
function vocabSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName('Vocab');
  if (!sh) {
    sh = ss.insertSheet('Vocab');
    sh.appendRow(['時間', '孩子', '單字', '詞性', '中文', '例句', '來源文章', '狀態']);
  }
  return sh;
}

function saveVocab_(req) {
  var child = req.child || '';
  var word = (req.word || '').trim();
  if (!word) throw new Error('沒有單字');
  var sh = vocabSheet_();
  // 去重：同一個孩子同一個字不重複
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][1]) === child &&
        String(values[i][2]).toLowerCase() === word.toLowerCase()) {
      return { added: false, reason: 'exists' };
    }
  }
  sh.appendRow([new Date(), child, word, req.pos || '', req.zh || '',
                req.example || '', req.article || '', req.status || 'new']);
  return { added: true };
}

function loadVocab_(req) {
  var child = req.child || '';
  var sh = vocabSheet_();
  var values = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    if (!child || String(values[i][1]) === child) {
      out.push({
        time: values[i][0], child: values[i][1], word: values[i][2],
        pos: values[i][3], zh: values[i][4], example: values[i][5],
        article: values[i][6], status: values[i][7], row: i + 1
      });
    }
  }
  return { words: out };
}

function updateVocab_(req) {
  var child = req.child || '';
  var word = (req.word || '').trim().toLowerCase();
  var status = req.status || '';
  var sh = vocabSheet_();
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][1]) === child &&
        String(values[i][2]).toLowerCase() === word) {
      sh.getRange(i + 1, 8).setValue(status);
      return { updated: true };
    }
  }
  return { updated: false };
}

// ---- Sheets：閱讀紀錄 --------------------------------------
function logSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName('ReadingLog');
  if (!sh) {
    sh = ss.insertSheet('ReadingLog');
    sh.appendRow(['時間', '孩子', '主題', '標題', '測驗得分', '總題數']);
  }
  return sh;
}

function saveReadingLog_(req) {
  var sh = logSheet_();
  sh.appendRow([new Date(), req.child || '', req.topic || '',
                req.title || '', req.score == null ? '' : req.score,
                req.total == null ? '' : req.total]);
  return { saved: true };
}

function loadReadingLog_(req) {
  var child = req.child || '';
  var sh = logSheet_();
  var values = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    if (!child || String(values[i][1]) === child) {
      out.push({
        time: values[i][0], child: values[i][1], topic: values[i][2],
        title: values[i][3], score: values[i][4], total: values[i][5]
      });
    }
  }
  return { logs: out };
}

// ---- 工具 ---------------------------------------------------
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
