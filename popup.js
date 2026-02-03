let token = null;
let rows = [];
let uploadedFileInfo = null; // Информация о загруженном файле

const $ = (id) => document.getElementById(id);
const logEl = $("log");

function log(msg) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent = `[${t}] ${msg}\n` + logEl.textContent;
}

function setSessionPill(ok, text) {
  const pill = $("sessionState");
  pill.classList.remove("ok", "bad");
  pill.classList.add(ok ? "ok" : "bad");
  pill.textContent = text;
}

// Отправляем в background, он найдёт вкладку с ЛК и перешлёт в content script
async function callBackground(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

async function checkSession() {
  try {
    log("Проверяю сессию через вкладку ЛК…");
    const res = await callBackground("LK_GET_TOKEN");
    
    if (!res?.ok || !res.token) {
      setSessionPill(false, "нет сессии/токена");
      log(`token не получен: ${res?.error || "неизвестно"}`);
      $("btnParse").disabled = true;
      $("btnResolve").disabled = true;
      $("btnSend").disabled = true;
      return;
    }

    token = res.token;

    const u = await callBackground("LK_GET_USER", { token });
    if (u.ok && u.json && u.json.user) {
      setSessionPill(true, `OK: ${u.json.user.fio || u.json.user.name || "user"}`);
      log("Сессия ок, token получен.");
      $("btnParse").disabled = false;
      $("btnResolve").disabled = rows.length === 0;
      $("btnSend").disabled = true;
    } else {
      setSessionPill(false, `ошибка getUser`);
      log(`getUser не прошёл: HTTP ${u.status}`);
    }
  } catch (e) {
    setSessionPill(false, "ошибка");
    log(String(e.message || e));
  }
}

// Парсинг CSV файла
function parseCSV(text) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  
  // Определяем разделитель: точка с запятой или запятая
  const sep = (lines[0].includes(";") && !lines[0].includes(",")) ? ";" : ",";
  
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(sep).map(s => s.trim());
    const fio = parts[0] || "";
    const group = parts[1] || "";
    if (!fio) continue;
    out.push({ fio, group, user_id: null, status: "ожидает" });
  }
  return out;
}

// Парсинг TXT файла (Текст Юникод с табуляцией)
function parseTXT(text) {
  // Удаляем BOM если есть
  if (text.charCodeAt(0) === 0xFEFF || text.charCodeAt(0) === 0xFFFE) {
    text = text.substring(1);
  }
  
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  
  const out = [];
  // Пропускаем первую строку (заголовок) и начинаем со второй
  for (let i = 1; i < lines.length; i++) {
    // Разделитель - табуляция
    const parts = lines[i].split('\t').map(s => s.trim());
    const fio = parts[0] || "";
    const group = parts[1] || "";
    if (!fio) continue;
    out.push({ fio, group, user_id: null, status: "ожидает" });
  }
  return out;
}

// Парсинг XLSX файла
async function parseXLSX(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = function(e) {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        
        // Берём первый лист
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        
        // Конвертируем в JSON (массив объектов)
        const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
        
        if (jsonData.length < 2) {
          resolve([]);
          return;
        }
        
        const out = [];
        // Пропускаем первую строку (заголовок) и начинаем со второй
        for (let i = 1; i < jsonData.length; i++) {
          const row = jsonData[i];
          const fio = String(row[0] || "").trim();
          const group = String(row[1] || "").trim();
          if (!fio) continue;
          out.push({ fio, group, user_id: null, status: "ожидает" });
        }
        
        resolve(out);
      } catch (error) {
        reject(error);
      }
    };
    
    reader.onerror = function(error) {
      reject(error);
    };
    
    reader.readAsArrayBuffer(file);
  });
}

// Определение типа файла и парсинг
async function parseFile(file) {
  const fileName = file.name.toLowerCase();
  
  if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
    log("Обнаружен Excel файл, обрабатываю…");
    uploadedFileInfo = { type: 'xlsx', name: file.name };
    return await parseXLSX(file);
  } else if (fileName.endsWith('.txt')) {
    log("Обнаружен TXT файл, обрабатываю…");
    uploadedFileInfo = { type: 'txt', name: file.name };
    const text = await file.text();
    return parseTXT(text);
  } else if (fileName.endsWith('.csv')) {
    log("Обнаружен CSV файл, обрабатываю…");
    uploadedFileInfo = { type: 'csv', name: file.name };
    const text = await file.text();
    return parseCSV(text);
  } else {
    // Пытаемся определить по содержимому
    log("Неизвестный тип файла, пытаюсь определить по содержимому…");
    const text = await file.text();
    
    // Если есть табуляции, скорее всего TXT
    if (text.includes('\t')) {
      log("Обнаружены табуляции, обрабатываю как TXT…");
      uploadedFileInfo = { type: 'txt', name: file.name };
      return parseTXT(text);
    } else {
      log("Обрабатываю как CSV…");
      uploadedFileInfo = { type: 'csv', name: file.name };
      return parseCSV(text);
    }
  }
}

// Функция экспорта данных с ID
function exportDataWithIDs() {
  if (!rows || rows.length === 0) {
    log("Нет данных для экспорта");
    return;
  }

  const fileType = uploadedFileInfo?.type || 'csv';
  const originalName = uploadedFileInfo?.name || 'students';
  
  // Убираем расширение из имени
  const baseName = originalName.replace(/\.(xlsx?|csv|txt)$/i, '');
  
  if (fileType === 'xlsx') {
    exportAsXLSX(baseName);
  } else if (fileType === 'txt') {
    exportAsTXT(baseName);
  } else {
    exportAsCSV(baseName);
  }
}

// Экспорт как CSV
function exportAsCSV(baseName) {
  // Определяем разделитель (используем запятую)
  const separator = ',';
  
  // Создаем заголовок
  let csvContent = 'ФИО,Группа,ID в ЛК,Статус\n';
  
  // Добавляем данные
  rows.forEach(row => {
    const fio = `"${row.fio.replace(/"/g, '""')}"`;
    const group = `"${row.group.replace(/"/g, '""')}"`;
    const userId = row.user_id || '';
    const status = `"${row.status.replace(/"/g, '""')}"`;
    csvContent += `${fio}${separator}${group}${separator}${userId}${separator}${status}\n`;
  });
  
  // Создаем blob и скачиваем
  const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, `${baseName}_with_ids.csv`);
  log(`Экспортировано ${rows.length} записей в CSV`);
}

// Экспорт как TXT (Текст Юникод с табуляцией)
function exportAsTXT(baseName) {
  // Создаем заголовок
  let txtContent = 'ФИО\tГруппа\tID в ЛК\tСтатус\n';
  
  // Добавляем данные
  rows.forEach(row => {
    const fio = row.fio;
    const group = row.group;
    const userId = row.user_id || '';
    const status = row.status;
    txtContent += `${fio}\t${group}\t${userId}\t${status}\n`;
  });
  
  // Создаем blob с UTF-16 LE BOM
  const utf16leContent = '\ufffe' + txtContent; // UTF-16 LE BOM
  const blob = new Blob([utf16leContent], { type: 'text/plain;charset=utf-16le;' });
  downloadBlob(blob, `${baseName}_with_ids.txt`);
  log(`Экспортировано ${rows.length} записей в TXT`);
}

// Экспорт как XLSX
function exportAsXLSX(baseName) {
  // Создаем массив данных для Excel
  const data = [
    ['ФИО', 'Группа', 'ID в ЛК', 'Статус']
  ];
  
  rows.forEach(row => {
    data.push([
      row.fio,
      row.group,
      row.user_id || '',
      row.status
    ]);
  });
  
  // Создаем workbook и worksheet
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  
  // Устанавливаем ширину колонок
  ws['!cols'] = [
    { wch: 30 }, // ФИО
    { wch: 10 }, // Группа
    { wch: 12 }, // ID в ЛК
    { wch: 20 }  // Статус
  ];
  
  // Добавляем worksheet в workbook
  XLSX.utils.book_append_sheet(wb, ws, 'Студенты');
  
  // Генерируем и скачиваем файл
  XLSX.writeFile(wb, `${baseName}_with_ids.xlsx`);
  log(`Экспортировано ${rows.length} записей в XLSX`);
}

// Вспомогательная функция для скачивания blob
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function resolveAll() {
  if (!token) return;

  $("btnResolve").disabled = true;
  $("btnSend").disabled = true;
  $("btnExport").disabled = true;

  const prog = $("progress");
  const progText = $("progressText");
  prog.max = rows.length;
  prog.value = 0;

  let found = 0;

  for (let i = 0; i < rows.length; i++) {
    const s = rows[i];
    prog.value = i + 1;
    progText.textContent = `${i+1}/${rows.length}`;
    s.status = "поиск…";

    try {
      const r = await callBackground("LK_SEARCH", { token, fio: s.fio });

      if (!r.ok || !r.json) {
        s.status = `ошибка HTTP ${r.status}`;
        log(`Поиск: ${s.fio} — HTTP ${r.status}`);
        continue;
      }

      const items = r.json.items || [];
      let matched = items;

      if (s.group) {
        matched = items.filter(x => String(x.group || "").trim() === String(s.group).trim());
      }

      if (matched.length === 1) {
        s.user_id = String(matched[0].id);
        s.status = "найден";
        found++;
      } else if (matched.length > 1) {
        const fioNorm = s.fio.toLowerCase().replaceAll("ё", "е").trim();
        const best = matched.find(x =>
          String(x.fio || x.name || "").toLowerCase().replaceAll("ё", "е").trim() === fioNorm
        );
        if (best) {
          s.user_id = String(best.id);
          s.status = "найден (точное ФИО)";
          found++;
        } else {
          s.status = `несколько (${matched.length})`;
        }
      } else {
        s.status = "не найден";
      }
    } catch (e) {
      s.status = `ошибка: ${e.message}`;
      log(`Ошибка поиска ${s.fio}: ${e.message}`);
    }

    await new Promise(res => setTimeout(res, 200));
  }

  log(`Готово. Найдено ID: ${found}/${rows.length}`);
  $("btnSend").disabled = found === 0;
  $("btnResolve").disabled = false;
  $("btnExport").disabled = false; // Активируем кнопку экспорта после поиска
}

async function sendAll() {
  if (!token) return;
  
  // Получаем HTML из contenteditable
  const msgEl = $("message");
  const msg = msgEl.innerHTML.trim();
  
  if (!msg || msgEl.textContent.trim() === "") { 
    log("Сообщение пустое."); 
    return; 
  }

  const targets = rows.filter(r => r.user_id);
  if (targets.length === 0) { 
    log("Нет найденных ID."); 
    return; 
  }

  $("btnSend").disabled = true;
  $("btnResolve").disabled = true;

  const prog = $("progress");
  const progText = $("progressText");
  prog.max = targets.length;
  prog.value = 0;

  let okCount = 0;

  for (let i = 0; i < targets.length; i++) {
    const s = targets[i];
    prog.value = i + 1;
    progText.textContent = `${i+1}/${targets.length}`;
    s.status = "отправка…";

    try {
      const r = await callBackground("LK_SEND", { 
        token, 
        to_id: s.user_id, 
        html: msg 
      });

      if (r.ok && r.json && r.json.result === "ok") {
        s.status = "отправлено";
        okCount++;
      } else {
        s.status = `ошибка (${r.status})`;
        log(`Ошибка отправки to_id=${s.user_id}: HTTP ${r.status}`);
      }
    } catch (e) {
      s.status = `ошибка: ${e.message}`;
      log(`Ошибка отправки ${s.fio}: ${e.message}`);
    }

    await new Promise(res => setTimeout(res, 300));
  }

  log(`Рассылка завершена: ${okCount}/${targets.length}`);
  $("btnResolve").disabled = false;
  $("btnSend").disabled = false;
}

$("btnCheck").addEventListener("click", checkSession);

$("btnParse").addEventListener("click", async () => {
  const f = $("csvFile").files?.[0];
  if (!f) { 
    log("Выбери файл."); 
    return; 
  }
  
  try {
    rows = await parseFile(f);
    $("countInfo").textContent = `Загружено: ${rows.length}`;
    log(`Файл загружен: ${rows.length} строк.`);
    $("btnResolve").disabled = rows.length === 0 || !token;
    $("btnSend").disabled = true;
    $("btnExport").disabled = true; // Деактивируем до завершения поиска
  } catch (error) {
    log(`Ошибка обработки файла: ${error.message}`);
    $("countInfo").textContent = `Ошибка: ${error.message}`;
  }
});

$("btnResolve").addEventListener("click", resolveAll);
$("btnSend").addEventListener("click", sendAll);
$("btnExport").addEventListener("click", exportDataWithIDs);

// Обработка кнопок показа/скрытия подсказок
document.querySelectorAll('.info-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const hintId = btn.getAttribute('data-hint');
    const hint = document.getElementById(hintId);
    if (hint) {
      hint.classList.toggle('hidden');
    }
  });
});

// Форматирование текста
const messageEditor = $("message");

// Обновление состояния кнопок форматирования
function updateFormatButtons() {
  document.querySelectorAll('.format-btn').forEach(btn => {
    const format = btn.getAttribute('data-format');
    const isActive = document.queryCommandState(format);
    btn.classList.toggle('active', isActive);
  });
}

// Обработка кнопок форматирования
document.querySelectorAll('.format-btn').forEach(btn => {
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault(); // Важно! Не теряем выделение
  });
  
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const format = btn.getAttribute('data-format');
    
    // Применяем/снимаем форматирование
    document.execCommand(format, false, null);
    
    // Обновляем состояние кнопок
    updateFormatButtons();
    
    // Возвращаем фокус в редактор
    messageEditor.focus();
  });
});

// Обновляем состояние кнопок при изменении выделения
messageEditor.addEventListener('mouseup', updateFormatButtons);
messageEditor.addEventListener('keyup', updateFormatButtons);
messageEditor.addEventListener('focus', updateFormatButtons);

// Обработка Enter - создаём абзацы <p>
messageEditor.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    
    // Вставляем <p> вместо <div> или <br>
    document.execCommand('formatBlock', false, 'p');
    
    // Создаём новый абзац
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    
    // Если курсор в конце абзаца, создаём новый
    const p = document.createElement('p');
    p.innerHTML = '<br>'; // Для пустого абзаца
    
    range.deleteContents();
    range.insertNode(p);
    
    // Перемещаем курсор в новый абзац
    range.setStart(p, 0);
    range.setEnd(p, 0);
    selection.removeAllRanges();
    selection.addRange(range);
  }
});

// Инициализация - если пусто, добавляем первый абзац
if (messageEditor.innerHTML.trim() === '') {
  messageEditor.innerHTML = '<p><br></p>';
}

// Показ/скрытие логгера по клику на версию
const verInfo = document.querySelector('.verInfo');
const logger = document.querySelector('.logger');

verInfo.addEventListener('click', () => {
  logger.classList.toggle('logger-visible');
});

// Скроллим лог вниз при добавлении новых записей
const originalLog = log;
log = function(msg) {
  originalLog(msg);
  if (logger.classList.contains('logger-visible')) {
    logEl.scrollTop = 0; // Новые записи сверху, так что не скроллим
  }
};