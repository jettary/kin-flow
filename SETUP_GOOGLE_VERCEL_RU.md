# KinFlow: Google OAuth, Neon и Vercel

Здесь описана публикация KinFlow с настоящим Google-входом. Все секреты остаются
в Neon, Vercel или локальном `.env.local`; в Git их добавлять нельзя.

## 1. Подготовить Git-репозиторий

Текущая папка приложения `/Users/distillery/work/KinFlow/codebase` уже является
Git-репозиторием и имеет удалённый `origin`. Перед импортом в Vercel отправьте в
него последнюю версию:

```sh
cd /Users/distillery/work/KinFlow/codebase
git status
git add README.md SETUP_GOOGLE_VERCEL_RU.md
git commit -m "Add deployment setup guide"
git push origin master
```

Если позже измените исходный код, отправляйте его в ту же production-ветку.
Vercel будет автоматически создавать новый production deployment после push.

Перед `git add` убедитесь, что `.env.local` отсутствует. Он уже исключён
`.gitignore`. Не коммитьте URL базы, Client Secret и `CRON_SECRET`.

## 2. Создать production-базу в Neon

KinFlow запускает Vercel Functions в Frankfurt (`fra1`). В Neon выберите
ближайший доступный европейский регион.

1. Откройте [Neon Console](https://console.neon.tech/) → **New Project**.
2. Назовите проект, например `kinflow-production`, выберите европейский регион и
   нажмите **Create project**. Neon создаст production-ветку, базу и роль.
3. Нажмите **Connect**. Выберите production-ветку, базу и роль.
4. Включите **Connection pooling** и скопируйте строку подключения. Она содержит
   `-pooler` в имени хоста. Это `DATABASE_URL` для Vercel.
5. Выключите Connection pooling и скопируйте прямую строку. Это временный
   `MIGRATION_DATABASE_URL`, нужный только для создания или обновления схемы.
6. Из каталога приложения выполните миграции:

   ```sh
   cd /Users/distillery/work/KinFlow/codebase
   MIGRATION_DATABASE_URL='postgresql://USER:PASSWORD@HOST/neondb?sslmode=require' npm run db:migrate
   ```

   Замените пример полной прямой строкой Neon. Одинарные кавычки нужны, поскольку
   в строке обычно есть символ `&`.

7. В Neon Console → **Tables** проверьте появление `users`, `families`,
   `transactions`, `ledger` и `schema_migrations`.

Для первой публикации можно применить созданную Neon роль. При командной работе
создайте отдельную runtime-роль с DML-доступом, а права менять схему оставьте
только роли миграций.

## 3. Создать проект Vercel и постоянный адрес

1. В [Vercel Dashboard](https://vercel.com/dashboard) выберите команду →
   **Add New → Project** → импортируйте репозиторий.
2. Для текущего репозитория поле **Root Directory** оставьте пустым: `package.json`
   расположен в корне `codebase`.
3. Проверьте настройки:

   | Поле             | Значение        |
   | ---------------- | --------------- |
   | Framework Preset | `Next.js`       |
   | Install Command  | `npm ci`        |
   | Build Command    | `npm run build` |
   | Node.js Version  | `24.x`          |

   Vercel обычно определит их автоматически; `package.json` KinFlow требует
   Node.js 24.

4. Нажмите **Deploy**. Это даёт начальный адрес вида
   `https://kinflow-…vercel.app`. Пока Google-вход ещё не настроен.
5. Выберите постоянный адрес приложения:

   - для быстрого запуска оставьте production-адрес `*.vercel.app`;
   - для реального продукта откройте **Settings → Domains**, добавьте свой домен,
     например `app.example.com`, и внесите DNS-записи, предложенные Vercel.

Далее `https://APP_DOMAIN` означает выбранный адрес, например
`https://app.example.com`. Он должен открываться по HTTPS и не должен иметь `/`
в конце. Не меняйте домен без обновления Google OAuth и `APP_URL`.

## 4. Получить Google Client ID и Client Secret

KinFlow применяет серверный OAuth 2.0 flow с PKCE. Нужны только Client ID и
Client Secret; пароль пользователя Google приложение никогда не получает.

### Экран согласия

1. Откройте [Google Cloud Console](https://console.cloud.google.com/).
2. Через верхний селектор нажмите **New Project**, назовите его `KinFlow
Production` и создайте.
3. Откройте **Google Auth Platform → Branding**. Если видите **Get started**,
   нажмите его.
4. Заполните **App name** (`KinFlow`), **User support email** и **Developer
   contact information**.
5. В **Audience** выберите:

   - **External** для обычных Google-аккаунтов;
   - **Internal** только для одной Google Workspace-организации.

6. Для ограниченного теста оставьте статус **Testing** и добавьте нужные адреса
   в **Audience → Test users**. Для публичного запуска выберите **Publish app /
   In production**.
7. В **Data Access** не добавляйте Drive, Calendar и другие API. KinFlow
   использует лишь `openid`, `email` и `profile` для входа — дополнительных прав
   к данным Google не требуется.

При выпуске для широкой аудитории Google может запросить подтверждение домена и
брендинга. На Branding добавьте реальные главную страницу, политику
конфиденциальности и условия, если консоль их запрашивает.

### Веб-клиент OAuth

1. Откройте **Google Auth Platform → Clients** → **Create client**.
2. Выберите **Web application** и назовите клиента `KinFlow production`.
3. В **Authorized redirect URIs** добавьте ровно:

   ```text
   https://APP_DOMAIN/api/auth/callback
   ```

   Например: `https://app.example.com/api/auth/callback`.

4. **Authorized JavaScript origins** текущему серверному flow не нужен. Оставьте
   его пустым. Если позднее будет добавлен Google JavaScript SDK, добавьте только
   origin без пути: `https://APP_DOMAIN`.
5. Нажмите **Create**. Сохраните оба значения в менеджере паролей:

   | Google        | Переменная KinFlow     |
   | ------------- | ---------------------- |
   | Client ID     | `GOOGLE_CLIENT_ID`     |
   | Client secret | `GOOGLE_CLIENT_SECRET` |

Client Secret показывается при создании. Если он потерян или раскрыт, создайте
новый secret в карточке клиента, обновите Vercel и лишь после проверки отключите
старый.

### Локальная проверка реального Google-входа

Создайте **отдельный** OAuth-клиент `KinFlow local` с callback:

```text
http://127.0.0.1:3000/api/auth/callback
```

Затем скопируйте `codebase/.env.example` в `codebase/.env.local` и укажите:

```dotenv
APP_URL=http://127.0.0.1:3000
GOOGLE_CLIENT_ID=LOCAL_CLIENT_ID.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=LOCAL_CLIENT_SECRET
DEMO_MODE=false
```

Перезапустите `npm run dev`. Production secret в `.env.local` не используйте.

## 5. Настроить переменные Vercel

В Vercel: проект → **Settings → Environment Variables**. Добавьте значения для
**Production**. Секретные переменные пометьте **Sensitive**; Vercel больше не
покажет их исходное значение.

| Имя                    | Значение                               | Sensitive |
| ---------------------- | -------------------------------------- | --------- |
| `DATABASE_URL`         | pooled URL Neon                        | Да        |
| `APP_URL`              | `https://APP_DOMAIN` без `/` в конце   | Нет       |
| `GOOGLE_CLIENT_ID`     | Client ID Google                       | Нет       |
| `GOOGLE_CLIENT_SECRET` | Client Secret Google                   | Да        |
| `CRON_SECRET`          | случайная строка не короче 16 символов | Да        |

Сгенерировать `CRON_SECRET` можно так:

```sh
openssl rand -hex 32
```

Не добавляйте префикс `NEXT_PUBLIC_` к `DATABASE_URL`,
`GOOGLE_CLIENT_SECRET` или `CRON_SECRET`: иначе переменная станет доступна
браузеру. `MIGRATION_DATABASE_URL` не требуется работающему Vercel-приложению —
храните её отдельно и используйте только для `npm run db:migrate`.

## 6. Выпустить production

1. Проверьте успешное выполнение миграций в Neon.
2. Сохраните Vercel-переменные из раздела 5 с финальным `APP_URL`.
3. В Google OAuth-клиенте добавьте тот же callback из раздела 4. URI должен
   совпадать посимвольно, включая `https`, домен и `/api/auth/callback`.
4. В Vercel откройте **Deployments** → **Redeploy** у production deployment,
   либо отправьте новый commit в production-ветку. Значения окружения действуют
   только в новых деплоях.
5. Откройте `https://APP_DOMAIN`, нажмите **Continue with Google**, войдите и
   создайте первую семью.
6. В **Settings → Cron Jobs** проверьте задачу `/api/cron/rates` с выражением
   `15 6 * * *`. Она обновляет курсы валют раз в день. Время Vercel — UTC; на
   Hobby-плане задача может стартовать в любой момент указанного часа.

`CRON_SECRET` защищает этот endpoint. Vercel передаёт его как Bearer token для
задачи из `vercel.json`; вручную вызывать endpoint не нужно.

## 7. Preview и staging

Preview-деплои получают изменяющиеся URL. Не задавайте им production `APP_URL`:
вход вернёт пользователя в production.

- Для простого и безопасного Preview не добавляйте Google credentials и не
  проверяйте там вход.
- Для полноценного staging создайте постоянный `https://staging.example.com`,
  отдельную Neon branch/database и отдельный Google OAuth client. Для staging
  ветки в Vercel добавьте отдельные Preview-переменные, включая `APP_URL`,
  `DATABASE_URL`, Client ID, Client Secret и `CRON_SECRET`.

Не копируйте production финансовые данные в Preview.

## 8. Диагностика

| Симптом                                  | Что проверить                                                                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `redirect_uri_mismatch`                  | Callback Google совпадает с `APP_URL + /api/auth/callback`; изменения могут применяться несколько минут.                                |
| «Google sign-in has not been configured» | В Vercel есть `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_URL`; после изменения сделан redeploy.                                   |
| Возврат на экран входа                   | Адрес в браузере и `APP_URL` одинаковы; не смешаны `www` и домен без `www`.                                                             |
| Ошибка базы или вечная загрузка          | `DATABASE_URL` — pooled URL Neon, миграции выполнены, Compute Neon доступен. Смотрите **Vercel → Logs**, не публикуя connection string. |
| Cron отвечает 401                        | `CRON_SECRET` задан в Production. Внешний вызов потребует `Authorization: Bearer CRON_SECRET`.                                          |

## Официальные ссылки

- [Google: OAuth clients](https://support.google.com/cloud/answer/15549257)
- [Google: consent screen, audience и scopes](https://developers.google.com/workspace/guides/configure-oauth-consent)
- [Google: production readiness](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification)
- [Neon: проекты](https://neon.com/docs/manage/projects)
- [Neon: connection strings и pooling](https://neon.com/docs/connect/connect-from-any-app)
- [Vercel: environment variables](https://vercel.com/docs/environment-variables)
- [Vercel: Cron Jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
