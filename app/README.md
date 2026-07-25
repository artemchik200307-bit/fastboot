# FASTBOOT AI Service v6

Сервис регулярно получает публичные данные Binance, запускает шесть агентов,
формирует согласованные сигналы и сохраняет их в Supabase.

## Запуск локально

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
uvicorn app.main:app --reload
```

## Render

Создайте новый Web Service из папки `ai-service` или используйте `render.yaml`.
После деплоя задайте в `dashboard.html` до подключения `dashboard.js`:

```html
<script>
  window.FASTBOOT_AI_API_URL = "https://YOUR-AI-SERVICE.onrender.com";
</script>
```

Без AI API ручной раздел продолжает отображать сигналы, уже сохранённые в Supabase.
