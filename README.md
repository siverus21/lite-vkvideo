# lite-vkvideo

> **Статус разработки.** Публичный API и стратегия получения превью могут измениться до стабильного релиза.

Лёгкий [web component](https://developer.mozilla.org/en-US/docs/Web/API/Web_components) для встраивания [VK Video](https://dev.vk.com/ru/widgets/video). Компонент показывает поверхность превью с кнопкой воспроизведения; официальный iframe плеера подключается только после действия пользователя (или при включённом `autoload`).

## Установка

```sh
npm i @siverus21/lite-vkvideo
```

```html
<script type="module" src="./node_modules/@siverus21/lite-vkvideo/lite-vkvideo.js"></script>
```

## Быстрый старт

```html
<lite-vkvideo
  oid="-22822305"
  videoid="456242110"
  hash="e037414127166efe"
  videotitle="Пример"
  hd="2"
></lite-vkvideo>
```

Параметры `oid`, `videoid` и `hash` берутся из кода экспорта / встраивания видео во VK.

## Превью (poster)

В отличие от YouTube, у VK нет стабильного публичного URL превью, вычисляемого только по идентификаторам. Прямое чтение `video_ext.php` из браузера блокируется политикой CORS.

Доступные варианты:

| Вариант | Поведение |
|---------|-----------|
| Атрибут `poster` | Используется заданный URL изображения |
| Same-origin `/vk-poster` | Опциональный Node-хелпер получает превью на сервере и возвращает JSON |
| Ничего из перечисленного | Тёмный плейсхолдер с кнопкой Play; iframe по клику загружается как обычно |

```html
<lite-vkvideo oid="…" videoid="…" hash="…" poster="https://cdn.example/preview.jpg"></lite-vkvideo>

<!-- автопревью через same-origin /vk-poster -->
<lite-vkvideo oid="…" videoid="…" hash="…"></lite-vkvideo>
```

### Прокси превью (`vk-poster.mjs`)

В пакет входит вспомогательный модуль на Node.js без внешних зависимостей. Контракт:

```
GET /vk-poster?oid=&id=&hash=
→ 200 { "url": "https://…" }
```

Его можно встроить в существующий HTTP-стек или запустить отдельно:

```sh
npm run poster
# либо:
node node_modules/@siverus21/lite-vkvideo/vk-poster.mjs
```

```js
import { resolvePoster, handlePosterRequest } from '@siverus21/lite-vkvideo/vk-poster';

const { status, body } = await resolvePoster({ oid, id, hash });
// либо: await handlePosterRequest(req, res);
```

Эндпоинт должен быть доступен на **том же origin**, что и страница (или проксироваться на `/vk-poster`), чтобы компонент мог обращаться к нему без CORS.

## Атрибуты виджета VK

Соответствие параметрам [виджета VK Video](https://dev.vk.com/ru/widgets/video):

| Атрибут | Query VK | Описание |
|---------|----------|----------|
| `oid` | `oid` | ID владельца (для сообществ — отрицательный) |
| `videoid` | `id` | ID видео |
| `hash` | `hash` | Ключ доступа из диалога экспорта |
| `hd` | `hd` | Качество: `1` 360p, `2` 480p, `3` 720p, `4` 1080p |
| `autoplay` | `autoplay` | Автовоспроизведение (`autoplay` / `autoplay="0"`) |
| `loop` | `loop` | Циклическое воспроизведение |
| `mute` | `muted` | Старт без звука (`muted=1` + `VK.VideoPlayer.mute()`) |
| `unmute` | `muted` | Принудительно со звуком; при наличии обоих приоритет у `mute` |
| `jsapi` | `js_api` | Включение `VK.VideoPlayer` |
| `t` | `t` | Смещение старта (`00h00m05s` или секунды) |
| `videostartat` | `t` | Смещение старта в секундах |
| `poster` | — | URL изображения превью |

Поведение autoplay по умолчанию: по клику iframe загружается с `autoplay=1`; при `autoload` — с `autoplay=0`, если не задано иное.

## Атрибуты компонента

| Атрибут | Описание |
|---------|----------|
| `videotitle` | Заголовок на превью / доступное имя |
| `videoplay` | Подпись кнопки воспроизведения (по умолчанию `Play`) |
| `params` | Дополнительная query-строка (не переопределяет `oid`, `id`, `hash`, `hd`, `t`, `autoplay`, `loop`, `muted`, `js_api`) |
| `autoload` | Вставка iframe при появлении элемента во viewport |
| `autopause` | Пауза при уходе элемента из viewport |
| `short` | Соотношение сторон 9:16 и loop |
| `border` | Рамка: пустое значение/`true` — по умолчанию, либо CSS-значение `border` |

## Локальное демо

```sh
npm start
```

Адрес: http://localhost:8001/demo/

Команда запускает `vk-poster.mjs --demo`: раздачу демо-файлов и эндпоинт `/vk-poster`. Для продакшена нужен только сам модуль `vk-poster` (без флага `--demo`), встроенный в ваш сервер.

## Лицензия

**MIT + [Commons Clause](https://commonsclause.com/)** — допускается свободное использование, копирование, изменение и встраивание (в том числе на коммерческих сайтах). Продажа самого программного обеспечения или продукта, ценность которого существенно определяется этой библиотекой, не разрешена.

Полный текст: [LICENSE](./LICENSE).
