const BASE = "https://e.mospolytech.ru";
const API = `${BASE}/old/lk_api.php`;

// POST запрос
async function postForm(url, formObj) {
  const body = new URLSearchParams(formObj || {});
  const r = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest"
    },
    body
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

// GET запрос
async function getJson(url, params) {
  const u = new URL(url);
  Object.entries(params || {}).forEach(([k, v]) => {
    // Для флагов типа getUser добавляем без значения (просто ключ)
    if (v === "") {
      u.searchParams.append(k, "");
    } else if (v !== null && v !== undefined) {
      u.searchParams.set(k, v);
    }
  });
  
  const r = await fetch(u.toString(), {
    method: "GET",
    credentials: "include",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest"
    }
  });
  
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

// Слушаем сообщения
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.type) return;

    try {
      // 1) Получить токен - ПИЗДИМ из localStorage!
      if (msg.type === "LK_GET_TOKEN") {
        // КЛЮЧ С БОЛЬШОЙ БУКВЫ!
        const token = localStorage.getItem('Token');
        
        if (!token) {
          sendResponse({
            ok: false,
            error: "Token не найден в localStorage. Авторизуйся в ЛК заново."
          });
          return;
        }

        // Проверяем что токен валидный
        const res = await getJson(API, { getUser: "", token });
        
        if (res.status === 200 && res.json?.user?.is_token_valid) {
          sendResponse({ 
            ok: true, 
            token,
            user: res.json.user
          });
        } else {
          sendResponse({
            ok: false,
            error: "Token невалидный или истёк. Перезайди в ЛК.",
            debug: { status: res.status, json: res.json }
          });
        }
        return;
      }

      // 2) Получить информацию о пользователе (с токеном)
      if (msg.type === "LK_GET_USER") {
        const res = await getJson(API, { 
          getUser: "", 
          token: msg.token || "" 
        });
        sendResponse({ ok: res.status === 200, ...res });
        return;
      }

      // 3) Поиск студентов по ФИО
      if (msg.type === "LK_SEARCH") {
        const res = await getJson(API, {
          getStudents: "",
          search: msg.fio || "",
          token: msg.token || "",
          page: "1",
          perpage: "50"
        });
        sendResponse({ ok: res.status === 200, ...res });
        return;
      }

      // 4) Отправить сообщение
      if (msg.type === "LK_SEND") {
        const u = new URL(API);
        u.searchParams.set("newMessage", "1");
        u.searchParams.set("to_id", msg.to_id || "");
        u.searchParams.set("token", msg.token || "");

        const body = new URLSearchParams({ text: msg.html || "" });

        const r = await fetch(u.toString(), {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json, text/plain, */*",
            "X-Requested-With": "XMLHttpRequest"
          },
          body
        });

        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}

        sendResponse({ 
          ok: r.status === 200 && json?.result === "ok", 
          status: r.status, 
          json, 
          text: text.slice(0, 200) 
        });
        return;
      }

    } catch (error) {
      sendResponse({
        ok: false,
        error: error.message,
        stack: error.stack
      });
    }
  })();

  return true;
});