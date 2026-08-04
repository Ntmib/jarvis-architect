# Патч: поддержка Telegram Business (ответы клиентам в личных чатах владельца)

Написано 2026-08-04 по запросу Евгении. Цель: бот должен обрабатывать `business_message`/`business_connection` апдейты Telegram — то, что приходит, когда владелец подключил бота через Настройки → Telegram Business → Чат-боты (требует Telegram Premium у владельца).

## Почему это не работает "само" сейчас
1. `index.js` не подписан на апдейты типа `business_message`/`business_connection` — grammY (используемая версия ^1.31.0) их поддерживает технически, но обработчиков для них в коде нет вообще.
2. Даже если добавить `bot.on("business_message", ...)` "в лоб" — сообщение не пройдёт проверку `isOwner(ctx)` (index.js:245), потому что `ctx.from` в business-сообщении — это КЛИЕНТ, который пишет владельцу, а не сам владелец. Нужна отдельная проверка: сообщение принадлежит business-подключению, которое установил именно владелец.

## Что нужно добавить (код ниже, вставить после блока `loadOwner()` / рядом с `isOwner`, до `bot.on("message:text", ...)`)

```js
// --- Telegram Business support ---
const BUSINESS_FILE = join(DATA_DIR, "business_connections.json");
let _businessConnections = {}; // business_connection_id -> { ownerId, isEnabled }

function loadBusinessConnections() {
  try {
    _businessConnections = JSON.parse(readFileSync(BUSINESS_FILE, "utf8"));
  } catch {
    _businessConnections = {};
  }
}
loadBusinessConnections();

function saveBusinessConnections() {
  writeFileSync(BUSINESS_FILE, JSON.stringify(_businessConnections, null, 2));
}

// Приходит, когда владелец подключает/отключает бота в Настройки → Telegram Business
bot.on("business_connection", async (ctx) => {
  const conn = ctx.businessConnection;
  const ownerMatches = String(conn.user.id) === String(_ownerId);
  if (!ownerMatches) return; // подключение не от владельца этого бота — игнорируем

  _businessConnections[conn.id] = {
    ownerId: String(conn.user.id),
    isEnabled: conn.is_enabled,
  };
  saveBusinessConnections();
  console.log(`[business] connection ${conn.id} — enabled: ${conn.is_enabled}`);
});

// Приходит новое сообщение в личном чате владельца (от клиента)
bot.on("business_message", async (ctx) => {
  const msg = ctx.businessMessage;
  const connId = msg.business_connection_id;
  const conn = _businessConnections[connId];
  if (!conn || !conn.isEnabled) return; // не наше подключение, или выключено

  // ВАЖНО: msg.from — это КЛИЕНТ, а не владелец. Не пропускать через isOwner().
  const clientText = msg.text;
  if (!clientText) return; // пока только текст, фото/голос — отдельная доработка

  // Отдельная сессия Claude на каждый чат клиента, чтобы не путать с личным диалогом владельца
  const sessionKey = `biz_${connId}_${msg.chat.id}`;
  const sessionId = sessions.get(sessionKey) || null;

  // ВАЖНО: промпт должен явно объяснять контекст — иначе Claude будет отвечать
  // так, как будто разговаривает с самой Евгенией, а не с её клиентом от её имени.
  const prompt = `[Сообщение от клиента ${msg.from.first_name || msg.from.username || "без имени"} в твоём личном Telegram-чате, через Business-подключение]\n\n${clientText}\n\n(Ответь клиенту от лица Евгении, коротко и по делу — это переписка с клиентом, не разговор с самой Евгенией)`;

  try {
    const result = await callClaude(prompt, sessionId);
    if (result.sessionId) {
      sessions.set(sessionKey, result.sessionId);
      saveSessions();
    }
    await ctx.api.sendMessage(msg.chat.id, result.text, {
      business_connection_id: connId,
    });
  } catch (err) {
    console.error("[business message error]", err.message);
    // Осознанно НЕ шлём ошибку клиенту напрямую — лучше тишина, чем "Произошла ошибка" от имени Евгении
  }
});
```

## Что нужно проверить/доделать перед боевым использованием (честно, не всё готово "из коробки")
1. **Формат ответа `sendResponse`/`callClaude`** — код выше использует `result.text` напрямую через `ctx.api.sendMessage`, а не через уже существующую функцию `sendResponse(ctx, text)` (index.js:2511) — потому что `sendResponse` может рассчитывать на обычный `ctx` не от business-сообщения (форматирование, разбивка на части и т.п.). Нужно свериться, работает ли `sendResponse` с `business_connection_id`, или писать упрощённую версию для этого случая.
2. **Права доступа бота** (видно на скриншоте Евгении: "Сообщения 4/4") должны быть включены полностью в настройках Business — иначе `sendMessage` с `business_connection_id` будет падать с ошибкой прав.
3. **Голосовые/фото от клиента** — в патче выше обрабатывается только текст, для полноты нужно продублировать логику из `bot.on("message:voice")`/`message:photo`, адаптировав под `business_message`.
4. **Что если Claude уходит в долгую задачу** (как в этой самой сессии — минуты ожидания) — клиент не должен видеть "печатает..." вечно или зависать без ответа. Нужен таймаут/эскалация "передать живому человеку", если ответ не пришёл за N секунд — ровно то, что уже прописано как правило в knowledge/sales-playbook.md и knowledge/call-prep-unfamiliar-niches.md (эскалация на человека при сбое).

## Как применить
Это НЕ применено к рабочему боту (~/.agent/bot/ — заблокирован для меня, обновляется централизованно). Файл лежит в ~/projects/jarvis-architect/bot/ — клон публичного репозитория github.com/Ntmib/jarvis-architect. Дальше два варианта:
1. Добавить `GITHUB_TOKEN` в /settings → 🔑 — тогда я могу оформить это как настоящий Pull Request в репозиторий.
2. Переслать этот файл напрямую тем, кто обслуживает бота/платформу "Завод Джарвиса" — как готовое решение, не абстрактный запрос.
