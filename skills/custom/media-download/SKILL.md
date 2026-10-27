---
name: media-download
description: Скачивание видео и аудио с любых платформ. Используй когда нужно скачать медиафайл с YouTube, Instagram, TikTok, Twitter.
---

# Скачивание медиа

## Apify MCP

Если подключён MCP `apify` — ищи актуальные actors для скачивания.

### Порядок работы

1. Сначала попробуй проверенный actor (см. таблицу ниже)
2. `fetch-actor-details` — прочитай input schema перед вызовом
3. `call-actor` — запусти. Для >2 мин: `async: true`, poll через `get-actor-run`
4. Если actor не сработал — ищи альтернативу через `search-actors`

### Проверенные actors (пробуй первыми)

| Платформа | Actor | Примечание |
|-----------|-------|-----------|
| YouTube | `api-ninja/youtube-video-downloader` | Возвращает adaptiveFormats с прямыми URL |
| YouTube | `johnvc/youtube-download-api` | Вход videoUrls; format: video (по умолчанию audio); отдаёт fileUrl на файл |
| Instagram | `apify/instagram-scraper` | 216K runs |
| TikTok | `clockworks/tiktok-scraper` | 151K runs |

Если проверенный actor не работает — ищи замену через search-actors. Actors ломаются, но в Store всегда есть рабочие.

### Стоимость

Cheerio/HTTP actors в 20x дешевле browser-based. Ставь timeout в callOptions.
Free: $5/мес compute. Dataset/KV Store: unnamed expire через 7 дней.

## Telegram совместимость

Telegram поддерживает ТОЛЬКО H.264 + AAC в MP4 для inline видео.
VP9, H.265, AV1 → аудио играет, картинка замирает.
YouTube и Instagram часто отдают VP9.

### Проверка кодека

```bash
ffprobe -v quiet -print_format json -show_streams file.mp4
```
Смотри `codec_name` в видео-стриме.

### Конвертация (если не H.264)

```bash
ffmpeg -i input -c:v libx264 -crf 23 -c:a aac -b:a 128k -movflags +faststart output.mp4
```

- Файл >50MB → добавь `-vf "scale=-2:720" -crf 28`
- CRF: 18 = почти без потерь, 23 = баланс, 28 = сжатие

### Аудио форматы

| Задача | Формат | Команда |
|--------|--------|---------|
| Telegram файл | MP3 или M4A | `-c:a aac -b:a 128k` |
| Telegram голосовое | OGG Opus | `-c:a libopus -b:a 64k` |
| Whisper STT | WAV 16kHz mono | `-vn -ar 16000 -ac 1 -c:a pcm_s16le` |

## Если Apify не подключён

Предложи подключить: /menu → 🔌 MCP → Добавить. Регистрация: console.apify.com (бесплатно, $5/мес).
