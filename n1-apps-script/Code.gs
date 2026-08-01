/*************************************************************
 * JLPT N1 読解トレーナー — Google Apps Script 後端（單人版）
 *
 * 跟小孩的英文閱讀後端「完全獨立」：
 *   - 自己的 Apps Script 專案、自己的部署網址
 *   - 自己的 Google Sheet（單人，不分小孩）
 *
 * 部署前只要做一件事：
 *   Apps Script 左邊「專案設定」→「指令碼屬性」→ 新增：
 *     屬性名稱：GEMINI_API_KEY   值：你的 Gemini 金鑰
 *   （可選）MODEL  值：gemini-2.5-flash   ← 不填就用預設
 *
 * 然後「部署」→「新增部署作業」→ 類型「網頁應用程式」
 *   執行身分：我自己
 *   誰可以存取：任何人
 * 複製產生的網址，貼進 n1-reading.html 的設定。
 *************************************************************/

var DEFAULT_MODEL = 'gemini-2.5-flash';

// ---- 入口 ----------------------------------------------------
function doGet(e) {
  return json_({ ok: true, msg: 'N1 読解トレーナー後端運作中 ✅' });
}

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents || '{}');
    var action = req.action || '';
    var data;
    switch (action) {
      case 'generateArticle': data = generateArticle_(req); break;
      case 'explainWord':     data = explainWord_(req);     break;
      case 'translate':       data = translate_(req);       break;
      case 'saveVocab':       data = saveVocab_(req);       break;
      case 'loadVocab':       data = loadVocab_(req);       break;
      case 'updateVocab':     data = updateVocab_(req);     break;
      case 'setReading':      data = setReading_(req);      break;
      case 'makeQuiz':        data = makeQuiz_(req);        break;
      case 'saveReadingLog':  data = saveReadingLog_(req);  break;
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
  var m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e2) {} }
  throw new Error('無法解析 AI 回傳的 JSON');
}

// ---- 出文章（JLPT N1 読解：六大問 + 斷詞）------------------
//
// req.qtype で本試験の大問を切替：
//   tan     問題8  内容理解(短文)   ~200字 / 1問   / 単篇
//   chu     問題9  内容理解(中文)   ~500字 / 3問   / 単篇
//   cho     問題10 内容理解(長文)   ~1000字/ 4問   / 単篇
//   tougou  問題11 統合理解         A・B各~320字/3問/2篇
//   shuchou 問題12 主張理解(長文)   ~1000字/ 4問   / 単篇
//   jouhou  問題13 情報検索         案内・広告~700字/2問/構造化

// 形態素トークン分割の共通ルール
var TOKEN_RULES_ =
  '【トークン分割ルール】本文を形態素トークンに分割する。トークンを順につなげると本文が完全に再現できること。\n' +
  '句読点・記号も1トークン。段落の切れ目は {"br":1}。\n' +
  '漢字を含むトークンには読み r（ひらがな）を付ける。かな/カタカナ/記号だけのトークンに r は不要。\n' +
  '内容語（名詞・動詞・形容詞など）には繁体中文の意味 zh を付ける。助詞など機能語には zh 不要。\n' +
  'N1 学習者がつまずきそうな重要語には "k":1（点線の下線が付く）。\n' +
  '各トークン形式：{"s":"表層形","r":"よみ","p":"品詞略(名/動/形/副/助/接 等)","zh":"繁中の意味","k":1}\n' +
  '【自己チェック（必須）】出力する前に、全トークンの s を順番に連結した文字列が本文と一字一句完全に一致するか必ず検算する。' +
  '抜け・重複・順序の入れ替え・句読点の欠落があれば修正してから出力する。連結して本文が復元できないトークン列は不可。\n';

var COMMON_TAIL_ =
  '解説・意味はすべて「繁體中文（台灣）」で書く。\n' +
  'glossary は本文中の N1 重要語を 6〜10 語。grammar は本文中の N1 文法を 2〜4 個。\n' +
  'quiz の answer は正解インデックス(0始まり)。JSON 以外は一切出力しない。\n';

function articleShape_(qCount, qtypeLabel) {
  return '"glossary": [ {"word":"重要語","reading":"よみ","pos":"品詞","zh":"繁中の意味","example":"短い日本語例文"} ],\n' +
    '"grammar":  [ {"point":"N1文法の形","reading":"読み(あれば)","zh":"繁中の解説","example":"本文中の例文","exZh":"例文の繁中訳"} ],\n' +
    '"quiz":     [ {"type":"' + qtypeLabel + '","q":"日本語の設問","options":["選1","選2","選3","選4"],"answer":0,"zh":"正解が正しく他が誤る理由を繁中で"} ]  // ' + qCount + '問\n';
}

function generateArticle_(req) {
  var qtype = req.qtype || 'chu';
  var topic = req.topic || '社会・経済';
  var prompt, out;

  if (qtype === 'tougou') {
    // 問題11 統合理解：A・B 二篇
    prompt =
      'あなたは JLPT N1「問題11 統合理解」の出題者。\n' +
      'テーマ「' + topic + '」について、立場や着眼点の異なる短い評論を2本（A・B、各およそ300〜360字）作る。\n' +
      '2本は同じ話題を扱いつつ、主張・視点が対比または相補の関係になること。\n' +
      '【重要】AとBは明確に異なる立場を取り、読み比べれば相違点がはっきり分かること。' +
      '両者が同じ主張の言い換え・繰り返しになってはいけない。' +
      '一方が肯定・他方が留保／一方が経済面・他方が人間面、のように軸をずらして対比させる。\n\n' +
      TOKEN_RULES_ + '\n' +
      '本文Aと本文Bをそれぞれ tokensA / tokensB に分割する。\n\n' +
      '設問は「AとBの共通点」「Aの筆者の考え／Bの筆者の考え」「一方の立場から他方をどう見るか」など統合理解型で3問。\n\n' +
      COMMON_TAIL_ +
      '次の JSON だけ返す：\n{\n' +
      '"format":"dual",\n"title":"全体のタイトル",\n"genre":"統合理解",\n' +
      '"labelA":"A","labelB":"B",\n' +
      '"articleA":"本文Aのプレーンテキスト全文（段落は \\n）。tokensA と完全一致させる（照合用）",\n' +
      '"articleB":"本文Bのプレーンテキスト全文（段落は \\n）。tokensB と完全一致させる（照合用）",\n' +
      '"tokensA":[ {"s":"","r":"","p":"","zh":"","k":1}, {"br":1} ],\n' +
      '"tokensB":[ ... ],\n' +
      articleShape_('3', '統合理解') + '}';
    out = callGemini_(prompt, true);
    out.format = out.format || 'dual';

  } else if (qtype === 'jouhou') {
    // 問題13 情報検索：構造化された案内・広告
    prompt =
      'あなたは JLPT N1「問題13 情報検索」の出題者。\n' +
      'テーマ「' + topic + '」に関する案内・広告・募集要項など、情報を探して読み取るタイプの文書を作る（全体でおよそ600〜800字相当）。\n' +
      '流れる散文ではなく、見出し・項目・料金/日程などの表・注意事項からなる「掲示物」の構造にする。\n' +
      '設問は「〜という条件に合うのはどれか」「Xさんが〜する場合、いくら／どうすればよいか」など、条件照合型で2問。\n\n' +
      COMMON_TAIL_ +
      '本文は流れる文章ではないので tokens は不要。代わりに info 構造で返す。\n' +
      '漢字の難語は glossary で拾う。\n\n' +
      '次の JSON だけ返す：\n{\n' +
      '"format":"info",\n"title":"掲示物のタイトル",\n"genre":"情報検索",\n' +
      '"info":{\n' +
      '  "intro":"導入文（あれば、なければ空文字）",\n' +
      '  "sections":[\n' +
      '    {"heading":"小見出し","rows":[{"label":"項目名","value":"内容"}],"table":{"headers":["列1","列2"],"rows":[["",""]]},"notes":["注意事項1","注意事項2"]}\n' +
      '  ]\n' +
      '},\n' +
      '"glossary": [ {"word":"重要語","reading":"よみ","pos":"品詞","zh":"繁中の意味","example":"短い例文"} ],\n' +
      '"quiz": [ {"type":"情報検索","q":"設問","options":["選1","選2","選3","選4"],"answer":0,"zh":"繁中の解説"} ]\n' +
      '}\n（各 section で rows / table / notes は不要なら省略可）';
    out = callGemini_(prompt, true);
    out.format = out.format || 'info';

  } else {
    // 単篇（tan / chu / cho / shuchou）
    var single = {
      tan:     { chars:'180〜260',  q:'1',   label:'内容理解', focus:'細部の内容理解や指示語（「それ」「この」が指す内容）を問う', genre:'評論/エッセイ' },
      chu:     { chars:'450〜620',  q:'3',   label:'内容理解', focus:'理由・因果・下線部の意味・指示語などを問う',         genre:'評論/論説' },
      cho:     { chars:'850〜1100', q:'4',   label:'内容理解', focus:'細部理解と全体の流れの両方を問う',                   genre:'論説/評論' },
      shuchou: { chars:'850〜1100', q:'4',   label:'主張理解', focus:'筆者の主張・最も言いたいこと・結論を中心に問う',      genre:'論説文' }
    }[qtype] || { chars:'450〜620', q:'3', label:'内容理解', focus:'内容理解を問う', genre:'評論/論説' };

    prompt =
      'あなたは JLPT N1 読解の出題者。\n' +
      'テーマ「' + topic + '」で、' + single.genre + '調の本格的な読解文を1本作る（およそ ' + single.chars + ' 字）。\n' +
      'N1 相当の語彙・文法（〜をものともせず、〜んがため、〜にかたくない 等）を自然に含める。\n' +
      '設問は' + single.focus + '形で ' + single.q + ' 問。\n\n' +
      TOKEN_RULES_ + '\n' +
      COMMON_TAIL_ +
      '次の JSON だけ返す：\n{\n' +
      '"format":"single",\n"title":"日本語のタイトル",\n"genre":"' + single.genre + ' のいずれか",\n' +
      '"article":"本文のプレーンテキスト全文。段落は \\n で区切る。tokens を連結したものと完全に一致させる（照合用）",\n' +
      '"tokens":[ {"s":"","r":"","p":"","zh":"","k":1}, {"br":1} ],\n' +
      articleShape_(single.q, single.label) + '}';
    out = callGemini_(prompt, true);
    out.format = out.format || 'single';
  }

  out.topic = topic;
  out.qtype = qtype;
  out.id = 'a' + Date.now();
  return out;
}

// ---- 點字查意思（依上下文）----------------------------------
function explainWord_(req) {
  var word = (req.word || '').trim();
  if (!word) throw new Error('沒有提供單字');
  var sentence = req.sentence || '';

  var prompt =
    '日本語の語を N1 学習者向けに繁體中文で説明する。語：「' + word + '」。' +
    (sentence ? 'この文に出てきた：「' + sentence + '」。この文脈に沿って説明する。' : '') +
    'JSON のみ返す：{"word":"表層形","reading":"よみ(ひらがな)","pos":"品詞","zh":"繁体中文の意味(簡潔)","example":"短い日本語例文","note":"慣用・活用など注意点があれば(なければ空文字)"}';

  return callGemini_(prompt, true);
}

// ---- 整段翻譯（日→中）--------------------------------------
function translate_(req) {
  var text = (req.text || '').trim();
  if (!text) throw new Error('沒有要翻譯的文字');
  var prompt =
    '次の日本語を、自然で通順な繁體中文（台灣）に訳す。' +
    '訳文だけを返し、原文・ふりがな・説明は一切付けない。\n\n日本語：\n' + text;
  return { zh: callGemini_(prompt, false).trim() };
}

// ---- 用筆記本出小考 ----------------------------------------
function makeQuiz_(req) {
  var items = req.words || []; // [{word, reading, zh, type}]
  if (!items.length) throw new Error('筆記本是空的');
  var prompt =
    'N1 学習者の復習小テストを作る。項目(JSON)：' + JSON.stringify(items) + '\n' +
    Math.min(items.length, 10) + '問の四択問題を作る。題型混合（意味を問う/例文の空所補充/用法）。\n' +
    '設問と選択肢は日本語、必要なら意味部分は繁体中文でよい。\n' +
    'JSON のみ返す：{"quiz":[{"q":"設問","options":["","","",""],"answer":正解インデックス,"word":"この問で問う項目の表層形"}]}';
  return callGemini_(prompt, true);
}

// ---- Sheets：筆記本（単語＋文法）---------------------------
function vocabSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName('Notebook');
  if (!sh) {
    sh = ss.insertSheet('Notebook');
    sh.appendRow(['時間', '種類', '表層形', '読み', '品詞', '意味', '例句', '來源', '狀態']);
  }
  return sh;
}

// 去重 key：種類 + 表層形 + 読み
function vkey_(type, word, reading) {
  return (type || 'word') + '|' + String(word).trim() + '|' + String(reading || '').trim();
}

function saveVocab_(req) {
  var type = req.type || 'word';       // 'word' | 'grammar'
  var word = (req.word || '').trim();
  if (!word) throw new Error('沒有項目');
  var reading = req.reading || '';
  var sh = vocabSheet_();
  var values = sh.getDataRange().getValues();
  var target = vkey_(type, word, reading);
  for (var i = 1; i < values.length; i++) {
    if (vkey_(values[i][1], values[i][2], values[i][3]) === target) {
      return { added: false, reason: 'exists' };
    }
  }
  sh.appendRow([new Date(), type, word, reading, req.pos || '', req.zh || '',
                req.example || '', req.source || '', req.status || 'new']);
  return { added: true };
}

function loadVocab_(req) {
  var sh = vocabSheet_();
  var values = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    out.push({
      time: values[i][0], type: values[i][1], word: values[i][2],
      reading: values[i][3], pos: values[i][4], zh: values[i][5],
      example: values[i][6], source: values[i][7], status: values[i][8], row: i + 1
    });
  }
  return { words: out };
}

function updateVocab_(req) {
  var type = req.type || 'word';
  var word = (req.word || '').trim();
  var reading = req.reading || '';
  var status = req.status || '';
  var sh = vocabSheet_();
  var values = sh.getDataRange().getValues();
  var target = vkey_(type, word, reading);
  for (var i = 1; i < values.length; i++) {
    if (vkey_(values[i][1], values[i][2], values[i][3]) === target) {
      sh.getRange(i + 1, 9).setValue(status);
      return { updated: true };
    }
  }
  return { updated: false };
}

// 追加/修改唸法（読み）。用 type+word+舊reading 定位該列，改寫読み欄
function setReading_(req) {
  var type = req.type || 'word';
  var word = (req.word || '').trim();
  var oldReading = req.oldReading || '';
  var reading = (req.reading || '').trim();
  var sh = vocabSheet_();
  var values = sh.getDataRange().getValues();
  var target = vkey_(type, word, oldReading);
  for (var i = 1; i < values.length; i++) {
    if (vkey_(values[i][1], values[i][2], values[i][3]) === target) {
      sh.getRange(i + 1, 4).setValue(reading);
      return { updated: true, reading: reading };
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
    sh.appendRow(['時間', '主題', '標題', '測驗得分', '總題數']);
  }
  return sh;
}

function saveReadingLog_(req) {
  var sh = logSheet_();
  sh.appendRow([new Date(), req.topic || '', req.title || '',
                req.score == null ? '' : req.score,
                req.total == null ? '' : req.total]);
  return { saved: true };
}

// ---- 每日打卡（單人）--------------------------------------
function checkSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName('DailyCheck');
  if (!sh) {
    sh = ss.insertSheet('DailyCheck');
    sh.appendRow(['日期', '完成']);
  }
  return sh;
}

function checkIn_(req) {
  var date = req.date || todayStr_();
  var done = req.done === false ? false : true;
  var sh = checkSheet_();
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (cellYmd_(values[i][0]) === date) {
      sh.getRange(i + 1, 2).setValue(done ? 'TRUE' : 'FALSE');
      return { date: date, done: done };
    }
  }
  sh.appendRow([date, done ? 'TRUE' : 'FALSE']);
  return { date: date, done: done };
}

function loadChecks_(req) {
  var sh = checkSheet_();
  var values = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    out.push({ date: cellYmd_(values[i][0]),
               done: String(values[i][1]).toUpperCase() === 'TRUE' });
  }
  return { checks: out };
}

function todayStr_() {
  var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}

function cellYmd_(v) {
  if (v instanceof Date) {
    var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  return String(v);
}

// ---- 工具 ---------------------------------------------------
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
