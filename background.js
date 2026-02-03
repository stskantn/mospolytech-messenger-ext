// Background просто пересылает сообщения к content script активной вкладки

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      // Находим вкладку с ЛК
      const tabs = await chrome.tabs.query({ 
        url: "https://e.mospolytech.ru/*" 
      });

      if (tabs.length === 0) {
        sendResponse({
          ok: false,
          error: "Открой вкладку ЛК: https://e.mospolytech.ru/ и авторизуйся"
        });
        return;
      }

      // Берём первую найденную вкладку с ЛК
      const lkTab = tabs[0];

      // Пересылаем сообщение в content script этой вкладки
      const response = await chrome.tabs.sendMessage(lkTab.id, msg);
      sendResponse(response);

    } catch (error) {
      sendResponse({
        ok: false,
        error: error.message,
        hint: "Убедись что вкладка ЛК открыта и ты авторизован"
      });
    }
  })();

  return true; // async
});