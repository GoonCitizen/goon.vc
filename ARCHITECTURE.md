# Архитектура goon.vc

Документ для владельца репозитория и следующих разработчиков: **что лежит в проекте** и **как это работает**.  
Детали деплоя — [`DEPLOY.md`](DEPLOY.md). Границы безопасности — [`SECURITY.md`](SECURITY.md). Краткие подсказки агентам — [`AGENTS.md`](AGENTS.md). План топологии — [`PLAN.md`](PLAN.md).

---

## Одной фразой

`goon.vc` — публичный HTML-сайт GOON SQUAD плюс узкий same-origin reverse-proxy на Fabric Hub (для логина Passport / GoonCitizen).  

Это **не** Fabric Hub и **не** LiveRelay.

| Хост | Роль | Этот репозиторий? |
|------|------|-------------------|
| **goon.vc** | GoonSPA (HTML) + Hub API zipper | да |
| **hub.fabric.pub** | Настоящий Hub: `/sessions`, identity, Beacon | нет |
| **relay.goon.vc** | GoonCitizen LiveRelay (`star-citizen-live`) | нет |

---

# A. Что есть в проекте

## Границы (чего здесь нет и не должно быть)

Сознательно отсутствует:

- Fabric Hub / Peer listen / Bitcoin / sidechain sync
- LiveRelay и `/services/star-citizen`
- Discord-бот в **рантайме** этого процесса (токен нужен только для офлайн-сборки расписания)
- React/webpack-сборка (сайт собирается простым Node-скриптом в один HTML)

Не раздувать это дерево обратно в Hub или relay — см. [`PLAN.md`](PLAN.md).

## Карта каталогов

| Путь | Назначение |
|------|------------|
| `services/` | Процесс сайта: `goon.vc.js` (`GoonVC`) — обёртка над `@fabric/http` HTTPServer |
| `types/` | Сборка HTML: `GoonSPA.js` (весь документ), `GoonSite.js`, `HTMLCompiler.js` |
| `components/` | Куски страниц: home, PERMAFLEET, schedule |
| `functions/` | Proxy на Hub, Discord→schedule, escapeHtml, обработчики логов |
| `assets/` | То, что отдаёт HTTP: `index.html`, картинки, favicon, schedule SVG/HTML |
| `settings/` | `local.js` — сайт, Hub origin, Discord guild для schedule |
| `contracts/` | Данные dossier: `permafleet/personalities/*.json`, `alliance.dot` |
| `scripts/` | CLI: `build.js`, `node.js` (start), `schedule.js` |
| `deploy/` | Примеры Caddy, systemd, env, nginx — не «живой» прод-конфиг сам по себе |
| `stores/` | Локальное хранилище процесса / snapshot Discord events |
| `tests/` | Mocha: сервис, proxy-поведение, schedule |
| Корень | `README.md`, `DEVELOPERS.md`, `API.md`, `SECURITY.md`, `PLAN.md`, `AGENTS.md` |

## Ключевые модули

| Файл | Зачем |
|------|--------|
| `services/goon.vc.js` | Старт HTTPServer: раздача `assets/`, SPA fallback, middleware Hub proxy |
| `functions/hubApiProxy.js` | Allowlisted reverse-proxy на `FABRIC_HUB_ORIGIN` |
| `types/GoonSPA.js` | Единый HTML-документ: стили, все `<main>`, клиентский роутер, login JS |
| `types/HTMLCompiler.js` | Пишет `assets/index.html` из GoonSPA (без webpack) |
| `types/GoonSite.js` | Тонкая связка FabricSite + GoonSPA |
| `components/HomePage.js` | Разметка и стили главной `/` |
| `components/PermafleetOperation.js` | Страница `/operations/PERMAFLEET` (+ Discord widget roster) |
| `components/PermafleetSchedule.js` | Страница расписания (встраивает готовый SVG) |
| `functions/discordScheduledEvents.js` | Fetch/нормализация Discord Guild Scheduled Events |
| `functions/scheduleGraphic.js` | SVG + standalone HTML week board |
| `functions/resolveDiscordToken.js` | Где взять bot token (env / secrets file) |
| `functions/escapeHtml.js` | Экранирование для шаблонов |
| `scripts/build.js` | `npm run build` |
| `scripts/node.js` | `npm start` |
| `scripts/schedule.js` | `npm run build:schedule` |

## Карта страниц (роуты)

Один собранный документ `assets/index.html`. Сервер при deep-link отдаёт его через SPA fallback; клиент показывает нужный `<main>` по `pathname`.

| URL | Откуда контент |
|-----|----------------|
| `/` | `components/HomePage.js` — заголовок, нав, Discord iframe, BTC, login |
| `/sessions` | Блок login внутри `GoonSPA.js` (HTML GET **не** проксируется на Hub) |
| `/dossier` | Карточки из `contracts/permafleet/personalities/*.json` |
| `/dossier/:handle` | Профиль той же JSON-записи |
| `/operations/PERMAFLEET` | `PermafleetOperation.js` (hero, текст, voice roster) |
| `/operations/PERMAFLEET/schedule` | `PermafleetSchedule.js` + `assets/permafleet-schedule.svg` |

Редиректы (сервер): `/permafleet` → `/operations/PERMAFLEET`, `/permafleet/schedule` → schedule.

Нав на главной (из `GoonSPA`): DOSSIER, PERMAFLEET, Monitor (`relay.goon.vc`), Login.

## Конфиг

Файл [`settings/local.js`](settings/local.js) (в git):

- `hub.origin` — upstream Hub (по умолчанию `https://hub.fabric.pub`)
- `http.port` / `interface` / `hostname` — слушатель (обычно `127.0.0.1:8080`)
- `discord.*` — guild / token path / snapshot для **сборки** расписания
- `site.*` — тексты, URL, Discord widget, bitcoin, copyright

Важные env (см. также `deploy/env.example`):

| Переменная | Смысл |
|------------|--------|
| `FABRIC_HUB_ORIGIN` | Куда проксировать Hub API |
| `FABRIC_HUB_PORT` | Порт HTTP (по умолчанию 8080) |
| `FABRIC_HUB_INTERFACE` | Bind (по умолчанию loopback) |
| `FABRIC_HUB_HOSTNAME` | Имя для sitemap / hostname |
| `DISCORD_BOT_TOKEN` / `DISCORD_SECRETS_FILE` / `DISCORD_GUILD_ID` | Только для `build:schedule` |

Секреты в git не коммитить. Токен Discord в `settings/local.js` не хранить — только env / secrets file.

## Deploy-артефакты (`deploy/`)

Примеры для прод-установки (подробности в [`DEPLOY.md`](DEPLOY.md)):

- `Caddyfile` — TLS и прокси на `:8080`
- `goonvc.service` — systemd unit
- `env.example` — шаблон `.env`
- `nginx-relay.example.conf` — пример relay (не путать hostname `relay.goon.vc` с этим zipper)

## Зависимости

| Пакет | Зачем здесь |
|-------|-------------|
| `@fabric/http` | HTTPServer, SPA fallback, allowlist Hub origin, FabricSite |
| `@fabric/discord` | Инструментарий для Discord API в schedule-пайплайне |

В рантайме `npm start` Discord-бот **не** поднимается.

---

# B. Как это работает

## Локальный запуск

```bash
nvm use                 # 24.15.0 — см. .nvmrc / package.json engines
npm i --allow-git=all
npm run build           # пересобрать assets/index.html
npm start               # http://127.0.0.1:8080
npm test                # mocha
```

После правок шаблонов/компонентов нужен снова `npm run build`, иначе сервер отдаёт старый `assets/index.html`.

## Build-пайплайн (сайт)

```text
settings/local.js
  → scripts/build.js
  → types/HTMLCompiler.js
  → types/GoonSite.js → types/GoonSPA.js (+ components/*)
  → assets/index.html
```

Без webpack/Babel: `_renderWith('')` пишет готовый HTML на диск.

## Runtime

```text
npm start
  → scripts/node.js
  → services/goon.vc.js (GoonVC)
  → assertAllowedFabricHub(origin)
  → @fabric/http HTTPServer
       ├── static: assets/
       ├── SPA fallback (кроме /services и /identity)
       ├── redirects (/permafleet → …)
       └── middleware hubApi → functions/hubApiProxy.js
```

По умолчанию слушает `127.0.0.1:8080`. В проде перед ним Caddy с HTTPS ([`DEPLOY.md`](DEPLOY.md)).

## Поток запроса: HTML vs Hub proxy

```text
Браузер ──► goon.vc (:8080)
              │
              ├─ страница / dossier / operations ──► assets (SPA)
              │
              └─ allowlisted API ──► FABRIC_HUB_ORIGIN
                   /sessions, /device-links,
                   /services/rpc,
                   /identity/cluster, /identity/cross-sign
```

Правила в `functions/hubApiProxy.js`:

1. Путь должен совпадать с префиксом из списка выше.
2. **Исключение:** `GET`/`HEAD` на `/sessions` или `/device-links` с `Accept: text/html` → **не** проксируется, отдаётся GoonSPA (login UI).
3. JSON-поллы, `POST /sessions`, identity, RPC → на Hub.
4. Ошибки upstream: `502` (unreachable) / `504` (timeout).

Клиент при загрузке делает `OPTIONS /services/rpc`. Если Hub недоступен (`hub-unreachable` / 502/504) — кнопки Login **скрываются** (HTML сайта при этом продолжает открываться).

## Login (кратко)

1. Пользователь открывает `/sessions` — HTML с этого процесса.
2. Создание сессии / poll / identity идут same-origin на те же пути, proxy пересылает на Hub.
3. `pollSecret` не должен попадать в `fabric://` / QR — см. [`SECURITY.md`](SECURITY.md).

## Schedule pipeline (build-time)

Отдельно от `npm start`:

```text
DISCORD_BOT_TOKEN (или secrets)
  → scripts/schedule.js
  → discordScheduledEvents.js
  → stores/discord/scheduled-events.json (snapshot)
  → scheduleGraphic.js
  → assets/permafleet-schedule.{svg,html}
```

Страница schedule только **показывает** уже собранные файлы. Есть режимы `--offline` / `--from-json`.

## Где что менять (шпаргалка)

| Задача | Куда смотреть |
|--------|----------------|
| Тексты главной, widget, BTC, copyright | `settings/local.js` → `site.*`, затем `npm run build` |
| Вёрстка/стили главной | `components/HomePage.js` (+ общий каркас в `types/GoonSPA.js`) |
| Страница PERMAFLEET | `components/PermafleetOperation.js` |
| Состав dossier | `contracts/permafleet/personalities/*.json` |
| Правила proxy / список путей | `functions/hubApiProxy.js` |
| Порт, Hub origin, bind | `settings/local.js` или env `FABRIC_HUB_*` |
| Обновить week board | `npm run build:schedule` (нужен Discord token или snapshot) |
| Деплой на сервер | `DEPLOY.md` + файлы в `deploy/` |

## Связанные документы

| Документ | Тема |
|----------|------|
| [`README.md`](README.md) | Quick start |
| [`DEVELOPERS.md`](DEVELOPERS.md) | Заметки разработчика этого сайта |
| [`API.md`](API.md) | Классы и список Hub zipper paths |
| [`DEPLOY.md`](DEPLOY.md) | Прод: Caddy, systemd, env |
| [`SECURITY.md`](SECURITY.md) | Что нельзя делать в этом дереве |
| [`PLAN.md`](PLAN.md) | Топология трёх хостов |
| [`AGENTS.md`](AGENTS.md) | Краткие правила для AI/агентов |
