# Подключение Premiere Pro и FL Studio к DeepSeek Harness

Эти программы платные, их нужно купить и установить самостоятельно. Когда они появятся — напишите Claude «подключи Premiere» или «подключи FL Studio», и он сделает шаги ниже и проверит работу.

---

## Blender

**MCP-сервер уже подключён** к DeepSeek Harness ([ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp), MIT, телеметрия выключена). Осталось поставить аддон внутрь Blender.

**Шаги после установки Blender:**
1. Запустите Blender один раз и закройте (он создаст папку настроек).
2. В **своём** терминале (PowerShell) выполните:
   ```
   $env:UV_PYTHON_INSTALL_DIR='C:\LLM\runtime\uv\python'; $env:UV_CACHE_DIR='C:\LLM\runtime\uv\cache'; $env:DISABLE_TELEMETRY='true'
   C:\LLM\runtime\uv\uvx.exe --python 3.12 blender-mcp@1.9.1 install-addon
   ```
3. Blender → **Edit → Preferences → Add-ons** → включить **MCP for Blender** (и снять галочку телеметрии).
4. В 3D-окне нажмите **N** → вкладка **MCP for Blender** → **Start MCP Server**.
5. В DeepSeek Harness (модель DeepSeek-V4-Pro) попросите, например: «создай в Blender низкополигональный домик».

**Осторожно:** инструмент `execute_blender_code` выполняет произвольный Python-код внутри Blender — сохраняйте проект перед работой агента.

> Портативная копия Blender 5.1.2 уже скачана в `C:\LLM\Blender` (архив — `C:\LLM\_zips\blender-5.1.2-windows-x64.zip`). Можно пользоваться ею (`C:\LLM\Blender\blender-5.1.2-windows-x64\blender.exe`) или удалить обе папки/файл, если ставите Blender сами.

---

## Adobe Premiere Pro

**MCP-сервер:** [hetpatel-11/Adobe_Premiere_Pro_MCP](https://github.com/hetpatel-11/Adobe_Premiere_Pro_MCP) — MIT, ~560 звёзд, 283 инструмента (таймлайн, нарезка, эффекты, экспорт).

**Требования:** Premiere Pro 2020–2026, Node.js 20+ (у вас v24 — подходит).

**Шаги:**
1. Установить сервер и мост CEP:
   ```
   npm install -g adobe-premiere-pro-mcp
   premiere-pro-mcp --install-cep
   ```
   `--install-cep` ставит панель-мост и включает режим отладки расширений Adobe (PlayerDebugMode) — это нужно для неподписанных расширений.
2. Перезапустить Premiere Pro → **Window → Extensions → MCP Bridge (CEP)** → указать папку моста, которую покажет установщик → **Start bridge**.
3. Добавить сервер в DeepSeek Harness (`~/.dsh/cordis.patch.yml`, секция `insert`):
   ```yaml
   - id: mcp-premiere
     name: '@deepseek-ai/dsh-mcp-client'
     config:
       transport: stdio
       serverName: premiere
       command: C:\Windows\System32\cmd.exe
       args: ['/c', 'premiere-pro-mcp']
       toolCallTimeoutMs: 300000
   ```
4. Перезапустить DeepSeek Harness и попросить агента выполнить `verify_premiere_connection`.

**Что ожидать:** хорошо — рутина (нарезка, раскладка клипов, субтитры, пакетный экспорт). Слабо — творческий монтаж «на глаз»: модель не видит видео.
**Осторожно:** всегда сохраняйте проект перед работой агента.

---

## FL Studio

**MCP-сервер:** [karl-andres/fl-studio-mcp](https://github.com/karl-andres/fl-studio-mcp) — MIT, ~146 звёзд (ноты, аккорды, паттерны, микшер, транспорт).

**Требования:** FL Studio 20.7+ (MIDI Controller Scripting API), виртуальный MIDI-порт [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html), Python 3.12 (ставится через uv автоматически).

**Шаги:**
1. Установить loopMIDI и создать порт (например, `FLStudio_MIDI`).
2. Скачать репозиторий и выполнить установщик (он ставит зависимости, MIDI-скрипт контроллера и скрипт Piano Roll `ComposeWithLLM`):
   ```
   git clone https://github.com/karl-andres/fl-studio-mcp C:\LLM\tools\fl-studio-mcp
   cd C:\LLM\tools\fl-studio-mcp
   .\install.ps1
   ```
3. В FL Studio: **Options → MIDI Settings** → выбрать порт loopMIDI → Controller type: скрипт `fl-studio-mcp`.
4. Добавить сервер в DeepSeek Harness:
   ```yaml
   - id: mcp-flstudio
     name: '@deepseek-ai/dsh-mcp-client'
     config:
       transport: stdio
       serverName: flstudio
       command: C:\LLM\runtime\uv\uv.exe
       args: ['run', '--directory', 'C:\LLM\tools\fl-studio-mcp', 'fl-studio-mcp']
   ```
5. Перезапустить DeepSeek Harness.

**Ограничения:** API FL Studio **не умеет загружать VST/AU-плагины** — только менять параметры уже загруженных. Модель не слышит звук: ноты и аранжировку набросает, сводить «на слух» не сможет.

---

## Про ресурсы компьютера
GTX 1080 Ti и 16 ГБ ОЗУ: Premiere Pro или Blender одновременно с локальной моделью Qwen не поместятся. Для работы с этими программами выбирайте в Harness **DeepSeek-V4-Pro** (через API), а не локальную модель.
