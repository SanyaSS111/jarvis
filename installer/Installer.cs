// J.A.R.V.I.S. installer: a single self-contained exe (C# 5 / .NET Framework 4.8 / WPF, built by build.ps1).
// The UI is ui.xaml (embedded). The payload.zip resource holds one folder per component. The offline
// bundle appended to the exe (see Bundle) carries the official downloads and ready trees from the build
// PC; whatever it lacks is downloaded from official sources and verified by SHA-256 before use.
// Run with /uninstall to remove an installation.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Management;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using Microsoft.Win32;

namespace Jarvis
{
    public class Component
    {
        public string Id, Title, Desc, Size;
        public string TitleRu, TitleEn, DescRu, DescEn;
        public bool Default, Required;
        public string[] Needs = new string[0];
        public CheckBox Box;
        public TextBlock TitleBlock, DescBlock, SizeBlock;
    }

    // Offline bundle appended to the exe by build.ps1 (outside the PE image, so it is never mapped into
    // memory): [exe][blob]...[index "name|offset|length|sha256" lines][int64 index length]["JRVSPACK"].
    // Blobs are zips: the official downloads (same SHA-256 as Src) and ready trees from the build PC.
    static class Bundle
    {
        class Blob { public long Offset, Length; public string Sha; }
        static readonly Dictionary<string, Blob> blobs = new Dictionary<string, Blob>(StringComparer.OrdinalIgnoreCase);
        public static readonly string ExePath = Assembly.GetExecutingAssembly().Location;
        public static long PeLength;

        static Bundle()
        {
            try
            {
                using (var f = File.OpenRead(ExePath))
                {
                    long end = SignatureStart(f);
                    PeLength = end;
                    if (end < 16) return;
                    var tail = new byte[16];
                    f.Seek(end - 16, SeekOrigin.Begin); ReadFull(f, tail);
                    if (Encoding.ASCII.GetString(tail, 8, 8) != "JRVSPACK") return;
                    long indexLen = BitConverter.ToInt64(tail, 0);
                    var index = new byte[indexLen];
                    f.Seek(end - 16 - indexLen, SeekOrigin.Begin); ReadFull(f, index);
                    long first = long.MaxValue;
                    foreach (var line in Encoding.UTF8.GetString(index).Split('\n'))
                    {
                        var p = line.Trim().Split('|');
                        if (p.Length != 4) continue;
                        var b = new Blob { Offset = long.Parse(p[1]), Length = long.Parse(p[2]), Sha = p[3] };
                        blobs[p[0]] = b;
                        first = Math.Min(first, b.Offset);
                    }
                    if (first != long.MaxValue) PeLength = first;
                }
            }
            catch { blobs.Clear(); }
        }

        // A code signature (Authenticode) is appended after the bundle: the bundle ends where it starts.
        static long SignatureStart(FileStream f)
        {
            try
            {
                var r = new BinaryReader(f);
                f.Position = 0x3C; long pe = r.ReadInt32();
                f.Position = pe + 24; ushort magic = r.ReadUInt16();
                f.Position = pe + 24 + (magic == 0x20b ? 112 : 96) + 4 * 8;
                long certOffset = r.ReadUInt32(), certSize = r.ReadUInt32();
                if (certOffset > 0 && certOffset + certSize == f.Length) return certOffset;
            }
            catch { }
            return f.Length;
        }

        static void ReadFull(Stream s, byte[] buf)
        {
            int got = 0, n;
            while (got < buf.Length && (n = s.Read(buf, got, buf.Length - got)) > 0) got += n;
            if (got != buf.Length) throw new EndOfStreamException();
        }

        public static bool Has(string name) { return blobs.ContainsKey(name); }
        public static bool HasSha(string name, string sha) { Blob b; return blobs.TryGetValue(name, out b) && b.Sha == sha; }
        public static long Size(string name) { return blobs[name].Length; }

        public static Stream Open(string name)
        {
            var b = blobs[name];
            return new Slice(new FileStream(ExePath, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16), b.Offset, b.Length);
        }

        // Re-hashes the blob: a truncated or damaged download of the installer fails here, not halfway through.
        public static void Verify(string name)
        {
            using (var s = Open(name))
            using (var h = SHA256.Create())
                if (BitConverter.ToString(h.ComputeHash(s)).Replace("-", "").ToLowerInvariant() != blobs[name].Sha)
                    throw new Exception(Installer.L("встроенный архив «" + name + "» повреждён — скачайте установщик заново", "the built-in archive \"" + name + "\" is damaged — download the installer again"));
        }

        // Read-only window [offset, offset+length) of a file.
        class Slice : Stream
        {
            readonly Stream inner; readonly long start, length; long pos;
            public Slice(Stream inner, long start, long length) { this.inner = inner; this.start = start; this.length = length; }
            public override bool CanRead { get { return true; } }
            public override bool CanSeek { get { return true; } }
            public override bool CanWrite { get { return false; } }
            public override long Length { get { return length; } }
            public override long Position { get { return pos; } set { pos = value; } }
            public override int Read(byte[] buffer, int offset, int count)
            {
                if (pos >= length) return 0;
                inner.Position = start + pos;
                int n = inner.Read(buffer, offset, (int)Math.Min(count, length - pos));
                pos += n;
                return n;
            }
            public override long Seek(long offset, SeekOrigin origin)
            {
                pos = origin == SeekOrigin.Begin ? offset : origin == SeekOrigin.Current ? pos + offset : length + offset;
                return pos;
            }
            public override void Flush() { }
            public override void SetLength(long value) { throw new NotSupportedException(); }
            public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
            protected override void Dispose(bool disposing) { if (disposing) inner.Dispose(); base.Dispose(disposing); }
        }
    }

    // Pinned downloads (versions tested with this setup).
    static class Src
    {
        public const string NodeUrl = "https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip";
        public const string NodeSha = "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73";
        public const string UvUrl = "https://github.com/astral-sh/uv/releases/download/0.12.13/uv-x86_64-pc-windows-msvc.zip";
        public const string UvSha = "a86c9dc7bad9b03f388583b7187c05fe9951c2e0d392217e8fd43d97787f6ec2";
        public const string LlamaBase = "https://github.com/ggml-org/llama.cpp/releases/download/b10964/";
        public const string LlamaCuda = "llama-b10964-bin-win-cuda-12.4-x64.zip";
        public const string LlamaCudaSha = "264f20d7ee3860aecca9ec12418357a9f3e80349a2b186f66c63859ded1a9593";
        public const string CudaRt = "cudart-llama-bin-win-cuda-12.4-x64.zip";
        public const string CudaRtSha = "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6";
        public const string LlamaVulkan = "llama-b10964-bin-win-vulkan-x64.zip";
        public const string LlamaVulkanSha = "1ee3ad952f4ba71f438bd6d7bebef19e1c7af04adcaa35d08b4ddabb27d4c642";
        public const string LlamaCpu = "llama-b10964-bin-win-cpu-x64.zip";
        public const string LlamaCpuSha = "917f39c076402c421224824607397af20f53625a60defc20e8dd22446bf4c5d7";
        public const string VectCutUrl = "https://codeload.github.com/sun-guannan/VectCutAPI/zip/b83be7404bf2343581744b2ef72c07d9fbe39b7e";
        public const string VectCutSha = "cdeacf5181cf9858a26a7a5b2acb8399613608b99b4d4b097b001f58b39220e7";
        public const string Dsh = "@deepseek-ai/dsh@0.1.5-rc.1";
        // npm 11 skips install scripts unless allowed; these build/fetch the agent's native parts.
        public const string DshScripts = "pnpm,@deepseek-ai/dsh-subprocess-local,koffi,@google/genai,protobufjs,node-pty";
        public const string Pnpm = "pnpm@12.4.1";
        public const string PlaywrightMcp = "@playwright/mcp@0.0.81";
        public const string WindowsMcp = "windows-mcp@0.8.5";
        public const string BlenderMcp = "blender-mcp@1.9.1";
        public const string Version = "1.2.1";
    }

    public class App
    {
        [STAThread]
        public static void Main(string[] args)
        {
            try { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | (SecurityProtocolType)12288; } // TLS 1.2 + 1.3
            catch { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12; }
            var app = new Application();
            app.ShutdownMode = ShutdownMode.OnMainWindowClose;
            var ui = new Installer(args);
            app.Run(ui.Window);
        }
    }

    public class Installer
    {
        public Window Window;
        readonly bool uninstall;
        string root;
        string gpuVendor = "none", gpuName = null;

        // Interface language: English by default, Russian on request (the EN / RU buttons, /lang:ru).
        // The choice goes to data\launcher\settings.json — the launcher, agent, Telegram bot and HUD follow it.
        static bool ru;
        bool langFromArgs;
        public static string L(string r, string e) { return ru ? r : e; }
        readonly List<Component> comps = new List<Component>();
        readonly StringBuilder logText = new StringBuilder();
        StreamWriter logFile;
        double progressBase, progressSpan;
        bool busy;

        T F<T>(string name) where T : class { return Window.FindName(name) as T; }

        public Installer(string[] args)
        {
            // uninstall.exe in the install folder is a copy of this program: a double-click on it (no arguments)
            // must uninstall too, not open the setup wizard.
            string exeName = Path.GetFileName(Assembly.GetExecutingAssembly().Location);
            uninstall = args.Any(a => a.Equals("/uninstall", StringComparison.OrdinalIgnoreCase))
                || exeName.Equals("uninstall.exe", StringComparison.OrdinalIgnoreCase)
                || exeName.Equals("jarvis-uninstall.exe", StringComparison.OrdinalIgnoreCase);
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("ui.xaml"))
                Window = (Window)XamlReader.Load(s);
            Window.Icon = System.Windows.Interop.Imaging.CreateBitmapSourceFromHIcon(
                System.Drawing.Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location).Handle,
                Int32Rect.Empty, System.Windows.Media.Imaging.BitmapSizeOptions.FromEmptyOptions());
            F<FrameworkElement>("TitleBar").MouseLeftButtonDown += (s, e) => { try { Window.DragMove(); } catch { } };
            F<Button>("CloseBtn").Click += (s, e) => { if (!busy) Window.Close(); };
            Window.Closing += (s, e) => { if (busy) e.Cancel = true; };
            StartReactor(1.0);
            ru = args.Any(a => a.Equals("/lang:ru", StringComparison.OrdinalIgnoreCase));
            langFromArgs = args.Any(a => a.StartsWith("/lang:", StringComparison.OrdinalIgnoreCase));
            F<Button>("LangEn").Click += (s, e) => SetLang(false);
            F<Button>("LangRu").Click += (s, e) => SetLang(true);
            DetectHardware();
            if (uninstall) SetupUninstall(); else SetupInstall();
        }

        void SetLang(bool russian)
        {
            if (busy) return;
            ru = russian;
            ApplyLang();
        }

        // Every static text of the window in the current language.
        void ApplyLang()
        {
            Window.Title = uninstall ? L("J.A.R.V.I.S. — удаление", "J.A.R.V.I.S. — uninstall") : L("J.A.R.V.I.S. — установка", "J.A.R.V.I.S. Setup");
            F<Button>("LangEn").Opacity = ru ? 0.45 : 1;
            F<Button>("LangRu").Opacity = ru ? 1 : 0.45;
            RenderHardware();
            if (uninstall) { ApplyUninstallTexts(); return; }
            int h = DateTime.Now.Hour;
            F<TextBlock>("Greeting").Text = (h < 5 ? L("Доброй ночи", "Good night") : h < 12 ? L("Доброе утро", "Good morning") : h < 18 ? L("Добрый день", "Good afternoon") : L("Добрый вечер", "Good evening")) + ".";
            F<TextBlock>("Subtitle").Text = L("УСТАНОВКА", "SETUP") + " · JUST A RATHER VERY INTELLIGENT SYSTEM";
            F<TextBlock>("Intro").Text = L("Этот мастер установит J.A.R.V.I.S. — ИИ-агента с голосом Джарвиса, локальные модели, обои HUD и оформление Windows. Вы сами выберете, что ставить. Всё скачивается с официальных источников и проверяется по контрольным суммам.",
                "This wizard installs J.A.R.V.I.S. — an AI agent with the Jarvis voice, local models, the HUD wallpaper and a Windows look. You choose what to install. Everything comes from official sources and is verified by checksums.");
            if (existingRoot != null)
                F<TextBlock>("Intro").Text += L("\n\nНайден установленный J.A.R.V.I.S. " + existingVersion + " в " + existingRoot + " — он будет обновлён, модели и настройки сохранятся.",
                    "\n\nFound J.A.R.V.I.S. " + existingVersion + " in " + existingRoot + " — it will be updated, models and settings are kept.");
            F<TextBlock>("ScanTitle").Text = L("СКАНИРОВАНИЕ СИСТЕМЫ", "SYSTEM SCAN");
            F<Button>("WelcomeNext").Content = L("ДАЛЕЕ  →", "NEXT  →");
            F<TextBlock>("CompTitle").Text = L("ЧТО УСТАНОВИТЬ", "WHAT TO INSTALL");
            F<Button>("CompBack").Content = L("←  НАЗАД", "←  BACK");
            F<Button>("CompNext").Content = L("ДАЛЕЕ  →", "NEXT  →");
            F<TextBlock>("FolderTitle").Text = L("ПАПКА УСТАНОВКИ", "INSTALL FOLDER");
            F<Button>("FolderBack").Content = L("←  НАЗАД", "←  BACK");
            F<Button>("InstallBtn").Content = L("УСТАНОВИТЬ", "INSTALL");
            F<Button>("BrowseBtn").Content = L("ОБЗОР", "BROWSE");
            F<TextBlock>("ShortcutText").Text = L("Ярлык J.A.R.V.I.S. на рабочем столе", "J.A.R.V.I.S. shortcut on the desktop");
            F<TextBlock>("KeyNote").Text = L("Ключ DeepSeek не входит в установку — после первого запуска агент попросит ваш собственный ключ (platform.deepseek.com). Локальные модели работают и без него.",
                "A DeepSeek key is not included — on first start the agent asks for your own key (platform.deepseek.com). Local models work without it.");
            F<TextBlock>("StepText").Text = L("Подготовка…", "Preparing…");
            F<Button>("DoneBtn").Content = L("ГОТОВО", "DONE");
            F<TextBlock>("DoneTitle").Text = L("Все системы в норме, сэр.", "All systems nominal, sir.");
            F<TextBlock>("LaunchText").Text = L("Запустить J.A.R.V.I.S.", "Launch J.A.R.V.I.S.");
            foreach (var c in comps)
            {
                c.Title = L(c.TitleRu, c.TitleEn);
                c.Desc = L(c.DescRu, c.DescEn);
                if (c.TitleBlock == null) continue;
                c.TitleBlock.Text = c.Title + (c.Required ? L("  · обязательно", "  · required") : "");
                c.DescBlock.Text = c.Desc;
                c.SizeBlock.Text = ru ? c.Size : c.Size.Replace("МБ", "MB").Replace("процессор", "CPU");
            }
            if (comps.Count > 0) UpdateSize();
            UpdateFolderInfo();
        }

        // ------------------------------------------------------------------ UI helpers
        void Show(string page)
        {
            foreach (var p in new[] { "PageWelcome", "PageComponents", "PageFolder", "PageProgress", "PageDone" })
                F<UIElement>(p).Visibility = p == page ? Visibility.Visible : Visibility.Collapsed;
        }

        void StartReactor(double speed)
        {
            Spin("Rot1", 24 / speed, false);
            Spin("Rot2", 40 / speed, true);
            Spin("Rot3", 12 / speed, false);
            var pulse = new DoubleAnimation(1.0, 1.08, TimeSpan.FromSeconds(1.6 / speed)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever };
            var sc = F<ScaleTransform>("CoreScale");
            sc.BeginAnimation(ScaleTransform.ScaleXProperty, pulse);
            sc.BeginAnimation(ScaleTransform.ScaleYProperty, pulse);
        }

        void Spin(string name, double seconds, bool reverse)
        {
            var a = new DoubleAnimation(reverse ? 360 : 0, reverse ? 0 : 360, TimeSpan.FromSeconds(seconds)) { RepeatBehavior = RepeatBehavior.Forever };
            F<RotateTransform>(name).BeginAnimation(RotateTransform.AngleProperty, a);
        }

        void Ui(Action a) { Window.Dispatcher.Invoke(a); }

        void Log(string line)
        {
            line = DateTime.Now.ToString("HH:mm:ss") + "  " + line;
            if (logFile != null) { try { logFile.WriteLine(line); logFile.Flush(); } catch { } }
            Ui(() =>
            {
                logText.AppendLine(line);
                if (logText.Length > 60000) logText.Remove(0, logText.Length - 50000);
                F<TextBlock>("LogText").Text = logText.ToString();
                F<ScrollViewer>("LogScroll").ScrollToEnd();
            });
        }

        void Step(string title, string detail)
        {
            Log("▸ " + title);
            Ui(() => { F<TextBlock>("StepText").Text = title; F<TextBlock>("StepDetail").Text = detail ?? ""; });
        }

        void Progress(double fraction, string text)
        {
            double v = (progressBase + progressSpan * Math.Max(0, Math.Min(1, fraction))) * 1000;
            Ui(() => { F<ProgressBar>("Progress").Value = v; if (text != null) F<TextBlock>("ProgressText").Text = text; });
        }

        // ------------------------------------------------------------------ hardware
        long ramMb;
        string winBuild = "";
        int winBuildNo;

        void DetectHardware()
        {
            try
            {
                using (var q = new ManagementObjectSearcher("SELECT Name, AdapterRAM FROM Win32_VideoController"))
                {
                    foreach (ManagementObject o in q.Get())
                    {
                        string n = (o["Name"] ?? "").ToString();
                        string low = n.ToLowerInvariant();
                        string v = low.Contains("nvidia") || low.Contains("geforce") || low.Contains("rtx") ? "nvidia"
                            : low.Contains("radeon") || low.Contains("amd") ? "amd"
                            : low.Contains("arc") ? "intel" : "other";
                        bool integrated = low.Contains("uhd") || low.Contains("iris") || (low.Contains("intel") && !low.Contains("arc")) || low.Contains("radeon(tm) graphics") || low.Contains("basic display");
                        if (integrated) continue;
                        if (gpuVendor == "none" || v == "nvidia") { gpuVendor = v; gpuName = n; }
                    }
                }
            }
            catch { }
            ramMb = 0;
            try
            {
                using (var q = new ManagementObjectSearcher("SELECT TotalPhysicalMemory FROM Win32_ComputerSystem"))
                    foreach (ManagementObject o in q.Get()) ramMb = (long)(Convert.ToUInt64(o["TotalPhysicalMemory"]) / 1048576);
            }
            catch { }
            try { winBuild = (Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentBuild", "") ?? "").ToString(); } catch { }
            int.TryParse(winBuild, out winBuildNo);
        }

        void RenderHardware()
        {
            int b = winBuildNo;
            F<TextBlock>("HwGpu").Text = L("Видеокарта: ", "GPU: ") + (gpuName ?? L("не найдена", "not found"));
            F<TextBlock>("HwRam").Text = L("Оперативная память: ", "RAM: ") + (ramMb / 1024) + L(" ГБ", " GB");
            F<TextBlock>("HwOs").Text = L("Система: ", "System: ") + (b >= 22000 ? "Windows 11" : "Windows 10") + L(" (сборка ", " (build ") + winBuild + ")";
            string engine = gpuVendor == "nvidia" ? L("CUDA — модели считаются на видеокарте NVIDIA", "CUDA — models run on the NVIDIA GPU")
                : gpuVendor == "amd" || gpuVendor == "intel" ? L("Vulkan — модели считаются на видеокарте", "Vulkan — models run on the GPU")
                : L("без дискретной видеокарты — модели будут работать на процессоре (подойдут лёгкие)", "no discrete GPU — models will run on the CPU (pick light ones)");
            F<TextBlock>("HwNote").Text = L("Движок локальных моделей: ", "Local model engine: ") + engine + "." + (b < 22000 ? L("\nОформление Windows (панель задач, Пуск) рассчитано на Windows 11.", "\nThe Windows look (taskbar, Start) is made for Windows 11.") : "");
        }

        // ------------------------------------------------------------------ install flow
        void SetupInstall()
        {
            string llamaSize = gpuVendor == "nvidia" ? "≈ 620 МБ (CUDA)" : gpuVendor == "none" || gpuVendor == "other" ? "≈ 20 МБ (процессор)" : "≈ 30 МБ (Vulkan)";
            comps.Add(new Component { Id = "core", TitleRu = "Лаунчер J.A.R.V.I.S.", TitleEn = "J.A.R.V.I.S. launcher", DescRu = "Панель управления в стиле Джарвиса, телеметрия, портативный Node.js.", DescEn = "A Jarvis-style control panel, telemetry, portable Node.js.", Size = "≈ 40 МБ", Default = true, Required = true });
            comps.Add(new Component { Id = "agent", TitleRu = "ИИ-агент DeepSeek Harness", TitleEn = "DeepSeek Harness AI agent", DescRu = "Агент с темой Джарвиса, пресетами и скиллами, интерфейс на английском или русском. Нужен свой ключ DeepSeek.", DescEn = "The agent with the Jarvis theme, presets and skills, English or Russian interface. Needs your own DeepSeek key.", Size = "≈ 600 МБ", Default = true, Needs = new[] { "core" } });
            comps.Add(new Component { Id = "voice", TitleRu = "Голос Джарвиса", TitleEn = "Jarvis voice", DescRu = "Голосовой режим агента: реактор, распознавание речи, озвучка ответов.", DescEn = "The agent's voice mode: the reactor, speech recognition, spoken replies.", Size = "≈ 150 МБ", Default = true, Needs = new[] { "agent" } });
            comps.Add(new Component { Id = "mcp", TitleRu = "Управление ПК и программами", TitleEn = "PC and app control", DescRu = "MCP-инструменты агента: окна Windows, браузер, Blender.", DescEn = "The agent's MCP tools: Windows windows, the browser, Blender.", Size = "≈ 300 МБ", Default = true, Needs = new[] { "agent", "voice" } });
            comps.Add(new Component { Id = "capcut", TitleRu = "Монтаж в CapCut", TitleEn = "CapCut editing", DescRu = "Агент собирает проекты CapCut (нужен установленный CapCut).", DescEn = "The agent builds CapCut projects (CapCut must be installed).", Size = "≈ 150 МБ", Default = false, Needs = new[] { "mcp" } });
            comps.Add(new Component { Id = "models", TitleRu = "Локальные модели", TitleEn = "Local models", DescRu = "Движок llama.cpp под вашу видеокарту. Сами модели — в лаунчере, по вкусу и по силам ПК.", DescEn = "The llama.cpp engine for your GPU. The models themselves are in the launcher, to taste and to what your PC can run.", Size = llamaSize, Default = true, Needs = new[] { "core" } });
            comps.Add(new Component { Id = "hud", TitleRu = "Живые обои J.A.R.V.I.S. HUD", TitleEn = "J.A.R.V.I.S. HUD live wallpaper", DescRu = "Анимированный HUD на рабочем столе: реактор, часы, датчики.", DescEn = "An animated HUD on the desktop: the reactor, a clock, sensors.", Size = "≈ 7 МБ", Default = true, Needs = new[] { "core" } });
            comps.Add(new Component { Id = "winlook", TitleRu = "Оформление Windows", TitleEn = "Windows look", DescRu = "Панель задач, Пуск, уведомления, Проводник, окна и Alt+Tab через встроенный Windhawk. Отключается в лаунчере.", DescEn = "Taskbar, Start, notifications, File Explorer, windows and Alt+Tab through the built-in Windhawk. Can be turned off in the launcher.", Size = "≈ 150 МБ", Default = true, Needs = new[] { "core" } });
            comps.Add(new Component { Id = "icons", TitleRu = "Иконки Джарвиса", TitleEn = "Jarvis icons", DescRu = "Значки рабочего стола, папок и ярлыков. Прежние сохраняются и возвращаются одной кнопкой.", DescEn = "Desktop, folder and shortcut icons. The old ones are backed up and restored with one button.", Size = "< 1 МБ", Default = false, Needs = new[] { "core" } });

            var list = F<StackPanel>("CompList");
            foreach (var c in comps)
            {
                var text = new StackPanel();
                var head = new DockPanel();
                c.SizeBlock = new TextBlock { FontSize = 12, Foreground = (Brush)Window.FindResource("Steel"), Margin = new Thickness(12, 0, 0, 0) };
                DockPanel.SetDock(c.SizeBlock, Dock.Right);
                head.Children.Add(c.SizeBlock);
                c.TitleBlock = new TextBlock { FontSize = 15 };
                head.Children.Add(c.TitleBlock);
                text.Children.Add(head);
                c.DescBlock = new TextBlock { FontSize = 12.5, Foreground = (Brush)Window.FindResource("Steel"), Margin = new Thickness(0, 3, 0, 0) };
                text.Children.Add(c.DescBlock);
                c.Box = new CheckBox { Content = text, IsChecked = c.Default, IsEnabled = !c.Required, Tag = c };
                c.Box.Checked += OnCompChecked;
                c.Box.Unchecked += OnCompUnchecked;
                list.Children.Add(c.Box);
            }
            DetectExisting();
            ApplyLang();

            F<Button>("WelcomeNext").Click += (s, e) => Show("PageComponents");
            F<Button>("CompBack").Click += (s, e) => Show("PageWelcome");
            F<Button>("CompNext").Click += (s, e) => { UpdateFolderInfo(); Show("PageFolder"); };
            F<Button>("FolderBack").Click += (s, e) => Show("PageComponents");
            F<TextBox>("FolderBox").TextChanged += (s, e) => UpdateFolderInfo();
            F<Button>("BrowseBtn").Click += (s, e) =>
            {
                using (var d = new System.Windows.Forms.FolderBrowserDialog { Description = L("Куда установить J.A.R.V.I.S.?", "Where to install J.A.R.V.I.S.?") })
                    if (d.ShowDialog() == System.Windows.Forms.DialogResult.OK)
                        F<TextBox>("FolderBox").Text = Path.Combine(d.SelectedPath, "JARVIS");
            };
            F<Button>("InstallBtn").Click += (s, e) => BeginInstall();
            F<Button>("DoneBtn").Click += (s, e) => Finish();
            Show("PageWelcome");

            // Unattended: /silent [/dir:C:\JARVIS] [/components:core,agent,...] [/noshortcut] [/nolaunch] [/lang:ru]
            string[] argv = Environment.GetCommandLineArgs();
            if (argv.Any(a => a.Equals("/silent", StringComparison.OrdinalIgnoreCase)))
            {
                silent = true;
                string dir = argv.Where(a => a.StartsWith("/dir:", StringComparison.OrdinalIgnoreCase)).Select(a => a.Substring(5)).FirstOrDefault();
                if (dir != null) F<TextBox>("FolderBox").Text = dir;
                string wantedList = argv.Where(a => a.StartsWith("/components:", StringComparison.OrdinalIgnoreCase)).Select(a => a.Substring(12)).FirstOrDefault();
                if (wantedList != null)
                {
                    var ids = wantedList.Split(',').Select(x => x.Trim()).ToList();
                    foreach (var c in comps) if (!c.Required) c.Box.IsChecked = false;
                    foreach (var c in comps) if (ids.Contains(c.Id)) c.Box.IsChecked = true;
                }
                if (argv.Any(a => a.Equals("/noshortcut", StringComparison.OrdinalIgnoreCase))) F<CheckBox>("ShortcutBox").IsChecked = false;
                if (argv.Any(a => a.Equals("/nolaunch", StringComparison.OrdinalIgnoreCase))) F<CheckBox>("LaunchBox").IsChecked = false;
                Window.Loaded += (s, e) => BeginInstall(true);
            }
        }

        bool silent;

        // ------------------------------------------------------------------ update over an existing install
        string existingRoot, existingVersion;

        // install.json of a folder: version and components, or null when J.A.R.V.I.S. is not installed there.
        static Tuple<string, List<string>> ReadInstallJson(string dir)
        {
            try
            {
                string json = File.ReadAllText(Path.Combine(dir, "install.json"), Encoding.UTF8);
                var v = System.Text.RegularExpressions.Regex.Match(json, "\"version\"\\s*:\\s*\"([^\"]*)\"");
                var c = System.Text.RegularExpressions.Regex.Match(json, "\"components\"\\s*:\\s*\\[([^\\]]*)\\]");
                var ids = c.Success ? System.Text.RegularExpressions.Regex.Matches(c.Groups[1].Value, "\"([^\"]+)\"").Cast<System.Text.RegularExpressions.Match>().Select(m => m.Groups[1].Value).ToList() : new List<string>();
                return Tuple.Create(v.Success ? v.Groups[1].Value : "?", ids);
            }
            catch { return null; }
        }

        // The installed copy (from "Apps & features", else C:\JARVIS): the folder, its components and language
        // become the defaults, so an update keeps what the person chose before.
        void DetectExisting()
        {
            var places = new List<string>();
            try { using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\JARVIS")) if (k != null) places.Add(k.GetValue("InstallLocation") as string); } catch { }
            places.Add(@"C:\JARVIS");
            foreach (var dir in places.Where(x => !string.IsNullOrEmpty(x)))
            {
                var info = ReadInstallJson(dir);
                if (info == null) continue;
                existingRoot = dir.TrimEnd('\\');
                existingVersion = info.Item1;
                F<TextBox>("FolderBox").Text = existingRoot;
                if (info.Item2.Count > 0)
                    foreach (var c in comps) c.Box.IsChecked = c.Required || info.Item2.Contains(c.Id);
                F<CheckBox>("ShortcutBox").IsChecked = File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "J.A.R.V.I.S..lnk"));
                // 1.0 had no language setting and was Russian-only.
                if (!langFromArgs)
                {
                    string s = "";
                    try { s = File.ReadAllText(Path.Combine(existingRoot, "data", "launcher", "settings.json"), Encoding.UTF8); } catch { }
                    var m = System.Text.RegularExpressions.Regex.Match(s, "\"lang\"\\s*:\\s*\"(\\w+)\"");
                    ru = m.Success ? m.Groups[1].Value == "ru" : true;
                }
                return;
            }
        }

        // PID listening on a local TCP port (netstat), 0 when none.
        static int ListeningPid(int port)
        {
            try
            {
                var psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "netstat.exe"), "-ano -p TCP") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
                using (var p = Process.Start(psi))
                {
                    string output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(5000);
                    foreach (var line in output.Split('\n'))
                    {
                        var cols = line.Trim().Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                        if (cols.Length >= 5 && cols[3].Equals("LISTENING", StringComparison.OrdinalIgnoreCase) && cols[1].EndsWith(":" + port)) return int.Parse(cols[4]);
                    }
                }
            }
            catch { }
            return 0;
        }

        static bool IsUnder(Process p, string dir)
        {
            try { return p.MainModule.FileName.StartsWith(dir.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase); } catch { return false; }
        }

        // Stops this install's processes: asks its launcher to shut the agent, models, ComfyUI and the bot down
        // (only when the launcher on port 3190 runs from this folder — another J.A.R.V.I.S. may own the port),
        // then ends whatever still runs from the folder. keepWindhawk: the Windows look stays on during an update.
        // Returns the names of the stopped programs.
        List<string> StopInstance(bool keepWindhawk)
        {
            var stopped = new List<string>();
            if (!Directory.Exists(root)) return stopped;
            int pid = ListeningPid(3190);
            bool ours = false;
            if (pid > 0) { try { using (var lp = Process.GetProcessById(pid)) ours = IsUnder(lp, root); } catch { } }
            if (ours)
            {
                try { var r = WebRequest.Create("http://127.0.0.1:3190/api/shutdown"); r.Method = "POST"; r.Headers["X-Jarvis"] = "1"; r.ContentLength = 0; r.Timeout = 15000; r.GetResponse().Close(); } catch { }
                Thread.Sleep(1500);
            }
            string windhawkDir = Path.Combine(root, "tools", "windhawk");
            int me = Process.GetCurrentProcess().Id;
            foreach (var p in Process.GetProcesses())
            {
                try
                {
                    if (p.Id == me || !IsUnder(p, root) || (keepWindhawk && IsUnder(p, windhawkDir))) continue;
                    string name = p.ProcessName;
                    p.Kill(); p.WaitForExit(5000);
                    if (!stopped.Contains(name)) stopped.Add(name);
                }
                catch { }
                finally { p.Dispose(); }
            }
            return stopped;
        }

        bool IsOn(string id) { var c = comps.FirstOrDefault(x => x.Id == id); return c != null && c.Box.IsChecked == true; }

        void OnCompChecked(object sender, RoutedEventArgs e)
        {
            var c = (Component)((CheckBox)sender).Tag;
            foreach (var n in c.Needs) { var d = comps.First(x => x.Id == n); if (d.Box.IsChecked != true) d.Box.IsChecked = true; }
            UpdateSize();
        }

        void OnCompUnchecked(object sender, RoutedEventArgs e)
        {
            var c = (Component)((CheckBox)sender).Tag;
            foreach (var d in comps.Where(x => x.Needs.Contains(c.Id))) if (d.Box.IsChecked == true) d.Box.IsChecked = false;
            UpdateSize();
        }

        void UpdateSize()
        {
            int n = comps.Count(c => c.Box.IsChecked == true);
            F<TextBlock>("SizeText").Text = L("Выбрано компонентов: " + n + " из " + comps.Count, "Components selected: " + n + " of " + comps.Count) + (Bundle.Has("vendor-dsh.zip")
                ? L(". Всё нужное уже внутри установщика — интернет почти не понадобится.", ". Everything needed is inside the installer — almost no internet needed.")
                : L(". Нужен интернет: всё тяжёлое скачивается при установке.", ". Internet needed: the heavy parts are downloaded during setup."));
        }

        void UpdateFolderInfo()
        {
            string p = F<TextBox>("FolderBox").Text.Trim();
            string info;
            try
            {
                var drive = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(p)));
                info = L("Свободно на диске " + drive.Name + ": " + (drive.AvailableFreeSpace / 1073741824) + " ГБ. Нужно до 2–3 ГБ, плюс место под модели.",
                    "Free on drive " + drive.Name + ": " + (drive.AvailableFreeSpace / 1073741824) + " GB. Up to 2–3 GB is needed, plus space for models.");
                if (p.Any(ch => ch > 127) || p.Contains(" ")) info += L("\nЛучше без пробелов и русских букв в пути — так надёжнее для всех инструментов.", "\nBetter without spaces or non-Latin letters in the path — more reliable for every tool.");
            }
            catch { info = L("Укажите полный путь, например C:\\JARVIS", "Enter a full path, for example C:\\JARVIS"); }
            Tuple<string, List<string>> there = null;
            try { there = ReadInstallJson(Path.GetFullPath(p)); } catch { }
            if (there != null)
                info += L("\nЗдесь уже стоит J.A.R.V.I.S. " + there.Item1 + " — он будет обновлён. Скачанные модели, ключ API, привязка Telegram и настройки агента сохранятся; запущенный J.A.R.V.I.S. остановится на время обновления.",
                    "\nJ.A.R.V.I.S. " + there.Item1 + " is already here — it will be updated. Downloaded models, the API key, the Telegram pairing and the agent settings are kept; a running J.A.R.V.I.S. is stopped for the update.");
            F<Button>("InstallBtn").Content = there != null ? L("ОБНОВИТЬ", "UPDATE") : L("УСТАНОВИТЬ", "INSTALL");
            F<TextBlock>("FolderInfo").Text = info;
        }

        void BeginInstall(bool unattended = false)
        {
            string p = F<TextBox>("FolderBox").Text.Trim();
            try { root = Path.GetFullPath(p).TrimEnd('\\'); } catch { MessageBox.Show(Window, L("Неверный путь к папке.", "Invalid folder path.")); return; }
            if (!unattended && Directory.Exists(root) && Directory.EnumerateFileSystemEntries(root).Any() && !File.Exists(Path.Combine(root, "install.json")))
            {
                if (MessageBox.Show(Window, L("Папка " + root + " не пустая. Установить в неё всё равно?", "The folder " + root + " is not empty. Install into it anyway?"), "J.A.R.V.I.S.", MessageBoxButton.YesNo) != MessageBoxResult.Yes) return;
            }
            var selected = comps.Where(c => c.Box.IsChecked == true).Select(c => c.Id).ToList();
            bool shortcut = F<CheckBox>("ShortcutBox").IsChecked == true;
            busy = true;
            F<UIElement>("LangBar").Visibility = Visibility.Collapsed;
            Show("PageProgress");
            StartReactor(3.0);
            F<TextBlock>("Subtitle").Text = L("ИДЁТ УСТАНОВКА", "INSTALLING");
            var t = new Thread(() => RunInstall(selected, shortcut)) { IsBackground = true };
            t.Start();
        }

        void RunInstall(List<string> sel, bool shortcut)
        {
            var failures = new List<string>();
            try
            {
                var previous = ReadInstallJson(root);
                prevComponents = previous != null ? previous.Item2 : new List<string>();
                Directory.CreateDirectory(root);
                Directory.CreateDirectory(Path.Combine(root, "data", "launcher"));
                logFile = new StreamWriter(Path.Combine(root, "data", "launcher", "install.log"), true, new UTF8Encoding(false));
                Log((previous != null ? L("Обновление J.A.R.V.I.S. " + previous.Item1 + " → ", "Updating J.A.R.V.I.S. " + previous.Item1 + " → ") : L("Установка J.A.R.V.I.S. ", "Installing J.A.R.V.I.S. ")) +
                    Src.Version + L(" в ", " in ") + root + L(" · компоненты: ", " · components: ") + string.Join(", ", sel) + " · lang: " + (ru ? "ru" : "en"));
                // Files of a running copy are in use (HUD exe) and its launcher would keep the old code.
                stoppedForUpdate = StopInstance(true);
                if (stoppedForUpdate.Count > 0) Log(L("Остановлено на время обновления: ", "Stopped for the update: ") + string.Join(", ", stoppedForUpdate));

                // Steps with rough weights (share of the progress bar).
                var steps = new List<Tuple<string, double, Action>>();
                steps.Add(Tuple.Create("core", 0.10, (Action)InstallCore));
                if (sel.Contains("agent")) steps.Add(Tuple.Create("agent", 0.30, (Action)InstallAgent));
                if (sel.Contains("voice")) steps.Add(Tuple.Create("voice", 0.12, (Action)InstallVoice));
                if (sel.Contains("mcp")) steps.Add(Tuple.Create("mcp", 0.14, (Action)InstallMcp));
                if (sel.Contains("capcut")) steps.Add(Tuple.Create("capcut", 0.08, (Action)InstallCapcut));
                if (sel.Contains("models")) steps.Add(Tuple.Create("models", 0.18, (Action)InstallModels));
                if (sel.Contains("hud")) steps.Add(Tuple.Create("hud", 0.02, (Action)InstallHud));
                if (sel.Contains("winlook")) steps.Add(Tuple.Create("winlook", 0.10, (Action)InstallWinlook));
                double total = steps.Sum(x => x.Item2), done = 0;
                selection = sel;
                foreach (var s in steps)
                {
                    progressBase = done / total; progressSpan = s.Item2 / total;
                    try { s.Item3(); }
                    catch (Exception ex)
                    {
                        Log(L("✖ Ошибка: ", "✖ Error: ") + ex.Message);
                        if (s.Item1 == "core") throw;
                        failures.Add(comps.First(c => c.Id == s.Item1).Title + ": " + ex.Message);
                    }
                    done += s.Item2;
                    Progress(0, null);
                }
                progressBase = 0.97; progressSpan = 0.03;
                Step(L("Финальная настройка", "Final setup"), L("Ярлыки, запись в «Приложения и возможности»", "Shortcuts, the \"Apps & features\" entry"));
                WriteLang();
                // Everything installed now or before: the full preset keeps the MCP rows of earlier tools.
                var all = prevComponents.Union(sel).ToList();
                if (all.Contains("agent")) ComposeFullPreset(all);
                WriteInstallJson(all);
                RegisterUninstall();
                if (shortcut) CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "J.A.R.V.I.S..lnk"));
                CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "J.A.R.V.I.S..lnk"));
                // One uninstall shortcut, named in the current language (an update may switch it).
                string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
                try { File.Delete(Path.Combine(programs, L("Uninstall J.A.R.V.I.S..lnk", "Удалить J.A.R.V.I.S..lnk"))); } catch { }
                CreateUninstallShortcut(Path.Combine(programs, L("Удалить J.A.R.V.I.S..lnk", "Uninstall J.A.R.V.I.S..lnk")));
                Progress(1, L("Готово", "Done"));
                Log(failures.Count == 0 ? L("✔ Установка завершена", "✔ Setup complete") : L("Установка завершена с ошибками: ", "Setup finished with errors: ") + failures.Count);
                Ui(() => { ShowDone(failures); if (silent) { Environment.ExitCode = failures.Count == 0 ? 0 : 2; Finish(); } });
            }
            catch (Exception ex)
            {
                Log(L("✖ Установка прервана: ", "✖ Setup aborted: ") + ex.Message);
                Ui(() =>
                {
                    F<TextBlock>("DoneTitle").Text = L("Сбой установки.", "Setup failed.");
                    F<TextBlock>("DoneTitle").Foreground = new SolidColorBrush(Color.FromRgb(255, 95, 86));
                    F<TextBlock>("DoneText").Text = ex.Message + L("\n\nЖурнал: ", "\n\nLog: ") + Path.Combine(root ?? "", "data", "launcher", "install.log") + L("\nПроверьте интернет и запустите установку ещё раз — уже скачанное не пропадёт.", "\nCheck your connection and run setup again — what was downloaded is kept.");
                    F<CheckBox>("LaunchBox").IsChecked = false;
                    F<CheckBox>("LaunchBox").Visibility = Visibility.Collapsed;
                    busy = false; Show("PageDone"); StartReactor(0.5);
                    if (silent) { Environment.ExitCode = 1; Window.Close(); }
                });
            }
            finally { if (logFile != null) { try { logFile.Dispose(); } catch { } logFile = null; } }
        }

        List<string> selection = new List<string>();
        List<string> prevComponents = new List<string>();
        List<string> stoppedForUpdate = new List<string>();

        void ShowDone(List<string> failures)
        {
            busy = false;
            StartReactor(1.0);
            F<TextBlock>("Subtitle").Text = L("УСТАНОВКА ЗАВЕРШЕНА", "SETUP COMPLETE");
            var sb = new StringBuilder();
            if (prevComponents.Count > 0)
            {
                F<TextBlock>("DoneTitle").Text = L("Обновление завершено, сэр.", "Update complete, sir.");
                sb.AppendLine(L("J.A.R.V.I.S. в ", "J.A.R.V.I.S. in ") + root + L(" обновлён до ", " is updated to ") + Src.Version + ".");
                if (stoppedForUpdate.Count > 0)
                    sb.AppendLine(L("На время обновления J.A.R.V.I.S. был остановлен: агента и Telegram-бота запустите снова в лаунчере.", "J.A.R.V.I.S. was stopped for the update: start the agent and the Telegram bot again in the launcher."));
            }
            else sb.AppendLine(L("J.A.R.V.I.S. установлен в ", "J.A.R.V.I.S. is installed in ") + root + ".");
            sb.AppendLine(L("Удалить: uninstall.exe в этой папке, «Пуск» → «Удалить J.A.R.V.I.S.» или «Приложения и возможности».", "To remove: uninstall.exe in this folder, Start → \"Uninstall J.A.R.V.I.S.\" or \"Apps & features\"."));
            if (selection.Contains("agent")) sb.AppendLine(L("При первом запуске агента введите свой ключ DeepSeek (platform.deepseek.com → API keys).", "When the agent first starts, enter your DeepSeek key (platform.deepseek.com → API keys)."));
            if (selection.Contains("models")) sb.AppendLine(L("Локальные модели: вкладка «Модели» в лаунчере — подборка под ваш ПК.", "Local models: the Models tab in the launcher — picks for your PC."));
            if (selection.Contains("winlook")) sb.AppendLine(L("Оформление Windows включится после запуска лаунчера (без встроенного Windhawk — докачается за пару минут).", "The Windows look turns on after the launcher starts (without the built-in Windhawk it downloads in a couple of minutes)."));
            sb.AppendLine(L("Язык можно поменять в лаунчере: «Система» → «Язык».", "You can change the language in the launcher: System → Language."));
            if (failures.Count > 0)
            {
                F<TextBlock>("DoneTitle").Text = L("Установлено, но не всё.", "Installed, but not everything.");
                sb.AppendLine();
                sb.AppendLine(L("Не получилось:", "Failed:"));
                foreach (var f in failures) sb.AppendLine("• " + f);
                sb.AppendLine(L("Запустите установщик ещё раз — он докачает недостающее.", "Run the installer again — it fetches what is missing."));
            }
            F<TextBlock>("DoneText").Text = sb.ToString();
            Show("PageDone");
        }

        void Finish()
        {
            if (root != null && !uninstall)
            {
                // The wallpaper was running before the update: bring it back.
                string hud = Path.Combine(root, "hud", "JarvisHUD2.exe");
                if (stoppedForUpdate.Contains("JarvisHUD2") && File.Exists(hud))
                    try { Process.Start(new ProcessStartInfo(hud) { WorkingDirectory = Path.GetDirectoryName(hud), UseShellExecute = true }); } catch { }
                if (F<CheckBox>("LaunchBox").IsChecked == true) StartLauncher();
            }
            Window.Close();
        }

        // ------------------------------------------------------------------ components
        void InstallCore()
        {
            Step(L("Лаунчер J.A.R.V.I.S.", "J.A.R.V.I.S. launcher"), L("Распаковка файлов", "Unpacking files"));
            ExtractPayload("core");
            Progress(0.2, null);
            string node = Path.Combine(root, "runtime", "node");
            if (!File.Exists(Path.Combine(node, "node.exe")))
            {
                Step("Node.js 24", L("Портативная версия, без установки в систему", "Portable, not installed system-wide"));
                Fetch(Src.NodeUrl, Src.NodeSha, 0.2, 0.9, node);
            }
            Progress(1, null);
        }

        void InstallAgent()
        {
            Step(L("ИИ-агент DeepSeek Harness", "DeepSeek Harness AI agent"), L("Файлы агента и голосового плагина", "Agent and voice plugin files"));
            ExtractPayload("agent");
            string projects = @"C:\Projects";
            try
            {
                Directory.CreateDirectory(Path.Combine(projects, ".dsh"));
                string rules = Path.Combine(projects, ".dsh", "rules.yaml");
                string tpl = Path.Combine(root, "agent", "rules.yaml");
                if (!File.Exists(rules) && File.Exists(tpl)) File.Copy(tpl, rules);
            }
            catch (Exception ex) { Log(L("Папка проектов: ", "Projects folder: ") + ex.Message); }
            Progress(0.1, null);
            string dshDir = Path.Combine(root, "runtime", "dsh");
            if (!File.Exists(Path.Combine(dshDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")))
            {
                Step(L("ИИ-агент DeepSeek Harness", "DeepSeek Harness AI agent"), L("Готовые файлы агента", "Prebuilt agent files"));
                if (!Unbundle("vendor-dsh.zip", dshDir, 0.1, 0.6))
                {
                    Step(L("ИИ-агент DeepSeek Harness", "DeepSeek Harness AI agent"), "npm: " + Src.Dsh + L(" (≈ 5 минут)", " (≈ 5 minutes)"));
                    // runtime\dsh\package-lock.json (from the payload) pins every package of the tested tree;
                    // its package.json carries the allowScripts policy (Src.DshScripts).
                    Npm("ci --no-fund --no-audit --loglevel=error", dshDir);
                }
            }
            Progress(0.6, null);
            Step(L("Плагины агента", "Agent plugins"), L("Русский интерфейс, поиск, счётчик стоимости, MCP, правила доступа, Джарвис", "Russian UI, search, cost counter, MCP, access rules, Jarvis"));
            string profile = Path.Combine(root, "agent", "home", "profiles", "web");
            string profileModules = Path.Combine(profile, "node_modules");
            if (Unbundle("vendor-profile.zip", profileModules, 0.6, 0.95))
                Junction(Path.Combine(profileModules, "dsh-jarvis"), Path.Combine(root, "agent", "plugins", "dsh-jarvis"));
            else
                Run(NodeExe(), "\"" + Path.Combine(dshDir, "node_modules", "pnpm", "bin", "pnpm.mjs") + "\" install --reporter=append-only", profile, AgentEnv(), 1200);
            Progress(1, null);
        }

        void InstallVoice()
        {
            EnsureUv();
            Step(L("Голос Джарвиса", "Jarvis voice"), L("Python 3.12 и синтез речи edge-tts", "Python 3.12 and edge-tts speech synthesis"));
            Run(UvExe("uv.exe"), "python install 3.12", root, UvEnv(), 900);
            Progress(0.6, null);
            UvWarm("uvx.exe", "{offline} --python 3.12 --from edge-tts edge-tts --help", root, 900);
            Progress(1, null);
        }

        void InstallMcp()
        {
            EnsureUv();
            Step(L("Управление ПК и программами", "PC and app control"), L("Браузер: Playwright MCP", "Browser: Playwright MCP"));
            string pw = Path.Combine(root, "tools", "mcp", "playwright");
            if (!Unbundle("vendor-playwright.zip", pw, 0, 0.4))
            {
                Directory.CreateDirectory(pw);
                Npm("install " + Src.PlaywrightMcp + " --prefix \"" + pw + "\" --no-fund --no-audit --loglevel=error", pw);
            }
            Progress(0.4, null);
            Step(L("Управление ПК и программами", "PC and app control"), "Windows-MCP");
            UvWarm("uvx.exe", "{offline} --python 3.12 " + Src.WindowsMcp + " --help", root, 900);
            Progress(0.7, null);
            Step(L("Управление ПК и программами", "PC and app control"), "Blender MCP");
            ExtractPayload("blender");
            UvWarm("uvx.exe", "{offline} --python 3.12 --from " + Src.BlenderMcp + " python -c 0", root, 600);
            Progress(1, null);
        }

        void InstallCapcut()
        {
            EnsureUv();
            string dir = Path.Combine(root, "tools", "mcp", "VectCutAPI");
            Step(L("Монтаж в CapCut", "CapCut editing"), "VectCutAPI (Apache-2.0)");
            if (!File.Exists(Path.Combine(dir, "mcp_server.py")))
            {
                Fetch(Src.VectCutUrl, Src.VectCutSha, 0, 0.3, dir, "vectcut.zip");
            }
            ExtractPayload("capcut");
            Progress(0.4, null);
            Step(L("Монтаж в CapCut", "CapCut editing"), L("Python-окружение и зависимости", "Python environment and dependencies"));
            if (!File.Exists(Path.Combine(dir, ".venv", "Scripts", "python.exe")))
                Run(UvExe("uv.exe"), "venv --python 3.12 .venv", dir, UvEnv(), 600);
            foreach (var req in new[] { "requirements.txt", "requirements-mcp.txt" })
                if (File.Exists(Path.Combine(dir, req)))
                    UvWarm("uv.exe", "pip install {offline} -r " + req + " --python .venv\\Scripts\\python.exe", dir, 1200);
            Progress(1, null);
        }

        void InstallModels()
        {
            string dir = Path.Combine(root, "runtime", "llama.cpp");
            if (File.Exists(Path.Combine(dir, "llama-server.exe"))) { Log(L("Движок llama.cpp уже установлен", "The llama.cpp engine is already installed")); Progress(1, null); return; }
            Directory.CreateDirectory(Path.Combine(root, "models"));
            if (gpuVendor == "nvidia")
            {
                Step(L("Движок локальных моделей", "Local model engine"), L("llama.cpp для NVIDIA (CUDA 12.4)", "llama.cpp for NVIDIA (CUDA 12.4)"));
                Fetch(Src.LlamaBase + Src.LlamaCuda, Src.LlamaCudaSha, 0, 0.45, dir);
                Step(L("Движок локальных моделей", "Local model engine"), L("Библиотеки CUDA", "CUDA libraries"));
                Fetch(Src.LlamaBase + Src.CudaRt, Src.CudaRtSha, 0.45, 0.95, dir);
            }
            else
            {
                bool gpu = gpuVendor == "amd" || gpuVendor == "intel";
                Step(L("Движок локальных моделей", "Local model engine"), gpu ? L("llama.cpp для видеокарты (Vulkan)", "llama.cpp for the GPU (Vulkan)") : L("llama.cpp для процессора", "llama.cpp for the CPU"));
                if (gpu) Fetch(Src.LlamaBase + Src.LlamaVulkan, Src.LlamaVulkanSha, 0, 0.95, dir);
                else Fetch(Src.LlamaBase + Src.LlamaCpu, Src.LlamaCpuSha, 0, 0.95, dir);
            }
            Progress(1, null);
        }

        void InstallHud()
        {
            Step(L("Живые обои J.A.R.V.I.S. HUD", "J.A.R.V.I.S. HUD live wallpaper"), "");
            ExtractPayload("hud");
            Progress(1, null);
        }

        // Windhawk with the mods already compiled and themed on the build PC; the launcher only switches it on.
        // Without the bundle the launcher downloads and compiles everything itself (-SetupLook).
        void InstallWinlook()
        {
            string dir = Path.Combine(root, "tools", "windhawk");
            if (File.Exists(Path.Combine(dir, "windhawk.exe"))) { Log(L("Windhawk уже установлен", "Windhawk is already installed")); Progress(1, null); return; }
            Step(L("Оформление Windows", "Windows look"), L("Windhawk и моды Джарвиса", "Windhawk and the Jarvis mods"));
            Unbundle("vendor-windhawk.zip", dir, 0, 1);
            Progress(1, null);
        }

        void EnsureUv()
        {
            if (File.Exists(UvExe("uv.exe"))) return;
            Step(L("Python-инструменты", "Python tools"), L("uv 0.12, Python 3.12 и кэш пакетов", "uv 0.12, Python 3.12 and the package cache"));
            string uv = Path.Combine(root, "runtime", "uv");
            Fetch(Src.UvUrl, Src.UvSha, 0, 0.1, uv);
            // Python 3.12 + the package cache of the build PC: MCP tools and the voice install without the internet.
            Unbundle("vendor-uv.zip", uv, 0.1, 0.5);
        }

        // Full agent preset = base + the MCP rows of the tools that were installed.
        void ComposeFullPreset(List<string> sel)
        {
            string dir = Path.Combine(root, "agent", "home", ".agent-presets", "full");
            string basePath = Path.Combine(dir, "_base.yml");
            if (!File.Exists(basePath)) return;
            var sb = new StringBuilder(File.ReadAllText(basePath, Encoding.UTF8));
            var wanted = new List<string> { "context7", "wolfram", "drawio", "comfyui" };
            if (sel.Contains("mcp")) wanted.AddRange(new[] { "playwright", "windows", "blender" });
            if (sel.Contains("capcut")) wanted.Add("capcut");
            foreach (var w in wanted)
            {
                string snip = Path.Combine(dir, "_mcp", w + ".yml");
                if (File.Exists(snip)) sb.Append("\n").Append(File.ReadAllText(snip, Encoding.UTF8));
            }
            File.WriteAllText(Path.Combine(dir, "agent.cordis.yml"), sb.ToString(), new UTF8Encoding(false));
            File.Delete(basePath);
            try { Directory.Delete(Path.Combine(dir, "_mcp"), true); } catch { }
            Log(L("Полный режим агента: MCP — ", "Agent full mode: MCP — ") + string.Join(", ", wanted));
        }

        // ------------------------------------------------------------------ plumbing
        string NodeExe() { return Path.Combine(root, "runtime", "node", "node.exe"); }
        string UvExe(string name) { return Path.Combine(root, "runtime", "uv", name); }

        Dictionary<string, string> BaseEnv()
        {
            var env = new Dictionary<string, string>();
            env["PATH"] = Path.Combine(root, "runtime", "node") + ";" + Path.Combine(root, "runtime", "dsh") + ";" + Environment.GetEnvironmentVariable("PATH");
            return env;
        }
        Dictionary<string, string> AgentEnv()
        {
            var env = BaseEnv();
            env["DSH_HOME"] = Path.Combine(root, "agent", "home");
            env["DSH_TELEMETRY_DISABLED"] = "1";
            return env;
        }
        Dictionary<string, string> UvEnv()
        {
            var env = BaseEnv();
            env["UV_PYTHON_INSTALL_DIR"] = Path.Combine(root, "runtime", "uv", "python");
            env["UV_CACHE_DIR"] = Path.Combine(root, "runtime", "uv", "cache");
            env["UV_TOOL_DIR"] = Path.Combine(root, "runtime", "uv", "tools");
            env["DISABLE_TELEMETRY"] = "true";
            env["ANONYMIZED_TELEMETRY"] = "false";
            return env;
        }

        void Npm(string args, string cwd)
        {
            string cli = Path.Combine(root, "runtime", "node", "node_modules", "npm", "bin", "npm-cli.js");
            Run(NodeExe(), "\"" + cli + "\" " + args, cwd, BaseEnv(), 1800);
        }

        // Network hiccups (DNS, resets) are common on home connections: retry the process up to 3 times.
        void Run(string exe, string args, string cwd, Dictionary<string, string> env, int timeoutSec, bool tolerant = false)
        {
            for (int attempt = 1; ; attempt++)
            {
                try { RunOnce(exe, args, cwd, env, timeoutSec, tolerant); return; }
                catch (Exception ex)
                {
                    if (attempt >= 3) throw;
                    Log("  ↻ " + ex.Message + L(" — повтор через 10 с (попытка ", " — retrying in 10 s (attempt ") + (attempt + 1) + L(" из 3)", " of 3)"));
                    Thread.Sleep(10000);
                }
            }
        }

        // Runs a hidden process, streams its output into the log, fails on a non-zero exit code.
        void RunOnce(string exe, string args, string cwd, Dictionary<string, string> env, int timeoutSec, bool tolerant)
        {
            Log("$ " + Path.GetFileName(exe) + " " + args);
            var psi = new ProcessStartInfo(exe, args)
            {
                WorkingDirectory = cwd, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
            };
            foreach (var kv in env) psi.EnvironmentVariables[kv.Key] = kv.Value;
            using (var p = Process.Start(psi))
            {
                p.StandardInput.Close();
                int lines = 0;
                DataReceivedEventHandler h = (s, e) => { if (e.Data != null && e.Data.Trim().Length > 0 && lines++ < 400) Log("  " + e.Data); };
                p.OutputDataReceived += h; p.ErrorDataReceived += h;
                p.BeginOutputReadLine(); p.BeginErrorReadLine();
                if (!p.WaitForExit(timeoutSec * 1000))
                {
                    try { p.Kill(); } catch { }
                    if (tolerant) { Log(L("  (остановлено по таймауту — это нормально для этого шага)", "  (stopped on timeout — normal for this step)")); return; }
                    throw new Exception(Path.GetFileName(exe) + L(": превышено время ожидания", ": timed out"));
                }
                p.WaitForExit();
                if (p.ExitCode != 0 && !tolerant) throw new Exception(Path.GetFileName(exe) + L(" завершился с кодом ", " exited with code ") + p.ExitCode);
            }
        }

        // Downloads into data\downloads, resumes nothing but re-uses a verified file, checks SHA-256.
        string Download(string url, string sha, double from, double to, string name = null)
        {
            string dir = Path.Combine(root, "data", "downloads");
            Directory.CreateDirectory(dir);
            string file = Path.Combine(dir, name ?? url.Substring(url.LastIndexOf('/') + 1));
            if (File.Exists(file) && Sha256(file) == sha) { Log(L("  уже скачано: ", "  already downloaded: ") + Path.GetFileName(file)); return file; }
            Log("  ↓ " + url);
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.UserAgent = "JARVIS-Setup/" + Src.Version;
            req.Timeout = 60000; req.ReadWriteTimeout = 120000;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var input = resp.GetResponseStream())
            using (var output = File.Create(file + ".part"))
            {
                long total = resp.ContentLength, got = 0;
                var buf = new byte[1 << 16];
                var sw = Stopwatch.StartNew();
                int n;
                while ((n = input.Read(buf, 0, buf.Length)) > 0)
                {
                    output.Write(buf, 0, n); got += n;
                    if (sw.ElapsedMilliseconds > 250)
                    {
                        sw.Restart();
                        double f = total > 0 ? (double)got / total : 0;
                        Progress(from + (to - from) * f, (got / 1048576) + (total > 0 ? L(" из ", " of ") + (total / 1048576) : "") + L(" МБ", " MB"));
                    }
                }
            }
            string actual = Sha256(file + ".part");
            if (actual != sha)
            {
                File.Delete(file + ".part");
                throw new Exception(L("контрольная сумма не совпала для ", "checksum mismatch for ") + Path.GetFileName(file) + L(" — файл повреждён или подменён, установка остановлена", " — the file is damaged or tampered with, setup stopped"));
            }
            if (File.Exists(file)) File.Delete(file);
            File.Move(file + ".part", file);
            Log(L("  ✔ SHA-256 совпал: ", "  ✔ SHA-256 matches: ") + Path.GetFileName(file));
            return file;
        }

        static string Sha256(string file)
        {
            using (var s = File.OpenRead(file))
            using (var h = SHA256.Create())
                return BitConverter.ToString(h.ComputeHash(s)).Replace("-", "").ToLowerInvariant();
        }

        // Official archive: taken from the offline bundle when it's there (same SHA-256), otherwise downloaded.
        void Fetch(string url, string sha, double from, double to, string dest, string name = null)
        {
            string file = name ?? url.Substring(url.LastIndexOf('/') + 1);
            if (Bundle.HasSha(file, sha))
            {
                Log(L("  из установщика: ", "  from the installer: ") + file);
                Bundle.Verify(file);
                using (var s = Bundle.Open(file)) ExtractZip(s, dest, true, from, to);
                return;
            }
            double mid = from + (to - from) * 0.8;
            string zip = Download(url, sha, from, mid, name);
            using (var s = File.OpenRead(zip)) ExtractZip(s, dest, true, mid, to);
            File.Delete(zip);
        }

        // Ready tree from the build PC (vendor-*.zip in the bundle); false when this installer has none.
        bool Unbundle(string name, string dest, double from, double to)
        {
            if (!Bundle.Has(name)) return false;
            Log(L("  из установщика: ", "  from the installer: ") + name + " (" + (Bundle.Size(name) / 1048576) + L(" МБ)", " MB)"));
            Bundle.Verify(name);
            using (var s = Bundle.Open(name)) ExtractZip(s, dest, false, from, to);
            return true;
        }

        // Extracts a zip; strips the single top folder if every entry is inside one.
        void ExtractZip(Stream zip, string dest, bool stripTop, double from = 0, double to = 0)
        {
            Directory.CreateDirectory(dest);
            using (var z = new ZipArchive(zip, ZipArchiveMode.Read))
            {
                string prefix = "";
                if (stripTop)
                {
                    var tops = z.Entries.Select(e => e.FullName.Split('/')[0]).Distinct().ToList();
                    if (tops.Count == 1 && z.Entries.All(e => e.FullName.Contains("/"))) prefix = tops[0] + "/";
                }
                string full = Path.GetFullPath(dest) + Path.DirectorySeparatorChar;
                int total = z.Entries.Count, done = 0;
                var sw = Stopwatch.StartNew();
                foreach (var e in z.Entries)
                {
                    done++;
                    if (to > from && sw.ElapsedMilliseconds > 250) { sw.Restart(); Progress(from + (to - from) * done / total, L("файлов: " + done + " из " + total, "files: " + done + " of " + total)); }
                    string rel = e.FullName.Replace('\\', '/').Substring(prefix.Length);
                    if (rel.Length == 0) continue;
                    string target = Path.GetFullPath(Path.Combine(dest, rel.Replace('/', '\\')));
                    if (!target.StartsWith(full, StringComparison.OrdinalIgnoreCase)) continue; // zip-slip guard
                    if (rel.EndsWith("/")) { Directory.CreateDirectory(target); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    e.ExtractToFile(target, true);
                }
            }
        }

        // Directory junction (no admin rights needed, unlike symlinks).
        void Junction(string link, string target)
        {
            if (Directory.Exists(link)) return;
            Directory.CreateDirectory(Path.GetDirectoryName(link));
            Run(Path.Combine(Environment.SystemDirectory, "cmd.exe"), "/c mklink /J \"" + link + "\" \"" + target + "\"", root, new Dictionary<string, string>(), 30);
        }

        // Offline first (everything is in the bundled uv cache), then online if something is missing.
        void UvWarm(string exe, string args, string cwd, int timeoutSec)
        {
            try { RunOnce(UvExe(exe), args.Replace("{offline}", "--offline"), cwd, UvEnv(), timeoutSec, false); }
            catch (Exception ex)
            {
                Log(L("  нет в кэше (", "  not in the cache (") + ex.Message + L(") — докачиваю", ") — downloading"));
                Run(UvExe(exe), args.Replace("{offline} ", "").Replace("{offline}", ""), cwd, UvEnv(), timeoutSec, true);
            }
        }

        // Personal files kept on an update: agent settings (default model, theme…), the person's own agent
        // instructions and patch layer (the launcher keeps its generated parts — local models, language — current).
        static readonly string[] KeepIfPresent = {
            @"agent\home\settings.yaml", @"agent\home\AGENTS.md", @"agent\home\cordis.patch.yml", @"tools\mcp\VectCutAPI\config.json",
        };

        static readonly string[] TextExt = { ".yml", ".yaml", ".json", ".js", ".md", ".ps1", ".cmd", ".txt", ".css", ".html", ".py", ".cpp" };

        // Payload folder <component>/ -> root, with {{ROOT}} placeholders filled in.
        void ExtractPayload(string component)
        {
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            using (var z = new ZipArchive(s, ZipArchiveMode.Read))
            {
                string prefix = component + "/";
                string rootFwd = root.Replace('\\', '/');
                string browser = File.Exists(@"C:\Program Files\Google\Chrome\Application\chrome.exe") || File.Exists(@"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe") ? "chrome" : "msedge";
                int count = 0, kept = 0;
                foreach (var e in z.Entries)
                {
                    string entry = e.FullName.Replace('\\', '/');
                    if (!entry.StartsWith(prefix) || entry.EndsWith("/")) continue;
                    count++;
                    string rel = entry.Substring(prefix.Length).Replace('/', '\\');
                    string target = Path.Combine(root, rel);
                    if (KeepIfPresent.Contains(rel, StringComparer.OrdinalIgnoreCase) && File.Exists(target)) { kept++; continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    if (TextExt.Contains(Path.GetExtension(target).ToLowerInvariant()))
                    {
                        byte[] bytes;
                        using (var es = e.Open()) using (var ms = new MemoryStream()) { es.CopyTo(ms); bytes = ms.ToArray(); }
                        bool bom = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF;
                        string text = new UTF8Encoding(false).GetString(bytes, bom ? 3 : 0, bytes.Length - (bom ? 3 : 0));
                        text = text.Replace("{{ROOT_JS}}", root.Replace("\\", "\\\\")).Replace("{{ROOT_FWD}}", rootFwd)
                                   .Replace("{{ROOT}}", root).Replace("{{BROWSER}}", browser);
                        File.WriteAllText(target, text, new UTF8Encoding(bom));
                    }
                    else e.ExtractToFile(target, true);
                }
                if (count == 0) throw new Exception(L("в установщике нет файлов компонента «" + component + "» — файл установщика повреждён", "the installer has no files for the \"" + component + "\" component — the installer file is damaged"));
                Log(L("  распаковано файлов: ", "  files unpacked: ") + (count - kept) + (kept > 0 ? L(", сохранено своих: ", ", personal files kept: ") + kept : ""));
            }
        }

        // data\launcher\settings.json: {"lang": "en" | "ru"} — read by the launcher, agent plugins, bot and HUD.
        // Sets "name": "value" in a flat JSON object kept as text (other keys untouched).
        static string SetJsonString(string json, string name, string value)
        {
            var key = new System.Text.RegularExpressions.Regex("\"" + name + "\"\\s*:\\s*\"[^\"]*\"");
            string pair = "\"" + name + "\": \"" + value + "\"";
            if (key.IsMatch(json)) return key.Replace(json, pair);
            if (json.StartsWith("{") && json.EndsWith("}") && json.Substring(1, json.Length - 2).Trim().Length > 0)
                return json.Substring(0, json.Length - 1).TrimEnd() + ",\n  " + pair + "\n}";
            return "{\n  " + pair + "\n}";
        }

        void WriteLang()
        {
            string file = Path.Combine(root, "data", "launcher", "settings.json");
            string lang = ru ? "ru" : "en";
            string json = "";
            try { if (File.Exists(file)) json = File.ReadAllText(file, Encoding.UTF8).Trim(); } catch { }
            var was = System.Text.RegularExpressions.Regex.Match(json, "\"lang\"\\s*:\\s*\"([^\"]*)\"");
            json = SetJsonString(json, "lang", lang);
            // A changed language: the agent window applies it once per stamp (dsh-jarvis client).
            if (!was.Success || was.Groups[1].Value != lang) json = SetJsonString(json, "langChangedAt", DateTime.UtcNow.ToString("o"));
            File.WriteAllText(file, json + "\n", new UTF8Encoding(false));
            Log(L("Язык интерфейса: русский", "Interface language: English"));
        }

        void WriteInstallJson(List<string> sel)
        {
            string json = "{\n  \"version\": \"" + Src.Version + "\",\n  \"installed\": \"" + DateTime.Now.ToString("s") + "\",\n  \"gpu\": \"" + gpuVendor +
                "\",\n  \"components\": [" + string.Join(", ", sel.Select(x => "\"" + x + "\"")) + "]\n}\n";
            File.WriteAllText(Path.Combine(root, "install.json"), json, new UTF8Encoding(false));
        }

        void RegisterUninstall()
        {
            string me = Assembly.GetExecutingAssembly().Location;
            string un = Path.Combine(root, "uninstall.exe");
            // Only the program itself, without the offline bundle appended to it.
            try { if (!string.Equals(me, un, StringComparison.OrdinalIgnoreCase)) CopyHead(me, un, Bundle.PeLength); } catch (Exception ex) { Log("uninstall.exe: " + ex.Message); }
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\JARVIS"))
            {
                k.SetValue("DisplayName", "J.A.R.V.I.S.");
                k.SetValue("DisplayVersion", Src.Version);
                k.SetValue("Publisher", "J.A.R.V.I.S.");
                k.SetValue("InstallLocation", root);
                k.SetValue("DisplayIcon", Path.Combine(root, "launcher", "icons", "jarvis.ico"));
                k.SetValue("UninstallString", "\"" + un + "\" /uninstall");
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }

        static void CopyHead(string from, string to, long length)
        {
            using (var i = File.OpenRead(from))
            using (var o = File.Create(to))
            {
                var buf = new byte[1 << 16];
                long left = length;
                int n;
                while (left > 0 && (n = i.Read(buf, 0, (int)Math.Min(buf.Length, left))) > 0) { o.Write(buf, 0, n); left -= n; }
            }
        }

        void CreateShortcut(string lnkPath)
        {
            try
            {
                var t = Type.GetTypeFromProgID("WScript.Shell");
                dynamic shell = Activator.CreateInstance(t);
                dynamic lnk = shell.CreateShortcut(lnkPath);
                lnk.TargetPath = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
                lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + Path.Combine(root, "launcher", "start.ps1") + "\"";
                lnk.WorkingDirectory = Path.Combine(root, "launcher");
                lnk.IconLocation = Path.Combine(root, "launcher", "icons", "jarvis.ico") + ",0";
                lnk.WindowStyle = 7;
                lnk.Description = L("J.A.R.V.I.S. — агент, локальные модели и оформление", "J.A.R.V.I.S. — the agent, local models and the look");
                lnk.Save();
                Log(L("Ярлык: ", "Shortcut: ") + lnkPath);
            }
            catch (Exception ex) { Log(L("Ярлык не создан: ", "Shortcut not created: ") + ex.Message); }
        }

        // A shortcut is removed only when it starts something in this install: another J.A.R.V.I.S. (a second
        // copy, a hand-made setup) may own a shortcut with the same name.
        static bool ShortcutPointsInto(string lnkPath, string dir)
        {
            try
            {
                dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
                dynamic lnk = shell.CreateShortcut(lnkPath);
                string where = (string)lnk.TargetPath + " " + (string)lnk.Arguments + " " + (string)lnk.WorkingDirectory;
                return where.IndexOf(dir.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase) >= 0;
            }
            catch { return false; }
        }

        void CreateUninstallShortcut(string lnkPath)
        {
            try
            {
                dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
                dynamic lnk = shell.CreateShortcut(lnkPath);
                lnk.TargetPath = Path.Combine(root, "uninstall.exe");
                lnk.Arguments = "/uninstall";
                lnk.WorkingDirectory = root;
                lnk.Description = L("Удалить J.A.R.V.I.S.", "Uninstall J.A.R.V.I.S.");
                lnk.Save();
            }
            catch (Exception ex) { Log(L("Ярлык удаления не создан: ", "Uninstall shortcut not created: ") + ex.Message); }
        }

        // Starts the launcher; asks it to set up the Windows look / icons if those were chosen.
        void StartLauncher()
        {
            var ps = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
            var args = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + Path.Combine(root, "launcher", "start.ps1") + "\"";
            string extra = "";
            // Only for parts added now: an update must not switch back on a look the person turned off.
            if (selection.Contains("winlook") && !prevComponents.Contains("winlook")) extra += " -SetupLook";
            if (selection.Contains("icons") && !prevComponents.Contains("icons")) extra += " -SetupIcons";
            Process.Start(new ProcessStartInfo(ps, args + extra) { UseShellExecute = false, CreateNoWindow = true });
        }

        // ------------------------------------------------------------------ uninstall
        void SetupUninstall()
        {
            root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string[] argv = Environment.GetCommandLineArgs();
            int i = Array.FindIndex(argv, a => a.Equals("/root", StringComparison.OrdinalIgnoreCase));
            if (i >= 0 && i + 1 < argv.Length) root = argv[i + 1];
            // The installed language (unless /lang:ru was given).
            try
            {
                string s = File.ReadAllText(Path.Combine(root, "data", "launcher", "settings.json"), Encoding.UTF8);
                if (System.Text.RegularExpressions.Regex.IsMatch(s, "\"lang\"\\s*:\\s*\"ru\"")) ru = true;
            }
            catch { }
            ApplyLang();
            F<Button>("WelcomeNext").Click += (s, e) =>
            {
                // Can't delete the folder we run from: continue from a temp copy.
                string me = Assembly.GetExecutingAssembly().Location;
                if (me.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                {
                    string tmp = Path.Combine(Path.GetTempPath(), "jarvis-uninstall.exe");
                    CopyHead(me, tmp, Bundle.PeLength);
                    Process.Start(tmp, "/uninstall /root \"" + root + "\" /go" + (ru ? " /lang:ru" : ""));
                    Window.Close();
                    return;
                }
                RunUninstallAsync();
            };
            F<Button>("DoneBtn").Click += (s, e) => Window.Close();
            F<CheckBox>("LaunchBox").Visibility = Visibility.Collapsed;
            Show("PageWelcome");
            if (argv.Any(a => a == "/go")) RunUninstallAsync();
        }

        void ApplyUninstallTexts()
        {
            F<TextBlock>("Subtitle").Text = L("УДАЛЕНИЕ", "UNINSTALL");
            F<TextBlock>("Greeting").Text = L("Удаление J.A.R.V.I.S.", "Uninstall J.A.R.V.I.S.");
            F<TextBlock>("Intro").Text = L("J.A.R.V.I.S. будет удалён с этого компьютера.", "J.A.R.V.I.S. will be removed from this PC.");
            F<TextBlock>("ScanTitle").Text = L("СИСТЕМА", "SYSTEM");
            F<Button>("WelcomeNext").Content = L("УДАЛИТЬ", "UNINSTALL");
            F<Button>("DoneBtn").Content = L("ГОТОВО", "DONE");
            F<TextBlock>("StepText").Text = L("Подготовка…", "Preparing…");
            F<TextBlock>("HwNote").Text = L("Будут удалены папка " + root + " (агент, модели, настройки), ярлыки и автозапуск. Стандартные значки и вид Windows вернутся.",
                "This removes the " + root + " folder (agent, models, settings), the shortcuts and autostart. Standard Windows icons and look come back.");
        }

        void RunUninstallAsync()
        {
            busy = true; F<UIElement>("LangBar").Visibility = Visibility.Collapsed; Show("PageProgress"); StartReactor(3.0);
            new Thread(() =>
            {
                var problems = new List<string>();
                progressBase = 0; progressSpan = 1;
                Step(L("Остановка J.A.R.V.I.S.", "Stopping J.A.R.V.I.S."), L("Агент, модели, обои, Windhawk", "Agent, models, wallpaper, Windhawk"));
                string wh = Path.Combine(root, "tools", "windhawk", "windhawk.exe");
                if (File.Exists(wh)) { try { var p = Process.Start(new ProcessStartInfo(wh, "-exit -wait -timeout 10000") { UseShellExecute = false, CreateNoWindow = true }); p.WaitForExit(20000); } catch { } }
                StopInstance(false);
                Progress(0.3, null);
                string winStyle = Path.Combine(root, "launcher", "tools", "win-style.ps1");
                if (File.Exists(Path.Combine(root, "data", "launcher", "win-style-backup.json")) && File.Exists(winStyle))
                {
                    Step(L("Возвращаю стандартные значки", "Restoring the standard icons"), "");
                    try { Run(Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"), "-NoProfile -ExecutionPolicy Bypass -File \"" + winStyle + "\" -Action restore", root, new Dictionary<string, string>(), 120, true); }
                    catch (Exception ex) { problems.Add(L("значки: ", "icons: ") + ex.Message); }
                }
                Progress(0.5, null);
                Step(L("Автозапуск и ярлыки", "Autostart and shortcuts"), "");
                try
                {
                    using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                        if (k != null) foreach (var n in new[] { "JarvisHUD2", "Windhawk (J.A.R.V.I.S.)", "J.A.R.V.I.S. Telegram" })
                            { var v = k.GetValue(n) as string; if (v != null && v.IndexOf(root, StringComparison.OrdinalIgnoreCase) >= 0) k.DeleteValue(n, false); }
                }
                catch (Exception ex) { problems.Add(L("автозапуск: ", "autostart: ") + ex.Message); }
                foreach (var lnk in new[] {
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "J.A.R.V.I.S..lnk"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "J.A.R.V.I.S..lnk"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Удалить J.A.R.V.I.S..lnk"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Uninstall J.A.R.V.I.S..lnk") })
                    try { if (File.Exists(lnk) && ShortcutPointsInto(lnk, root)) File.Delete(lnk); } catch { }
                // The "Apps & features" entry too only when it is this install's (it names the last installed copy).
                try
                {
                    string entry = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\JARVIS";
                    string location = null;
                    using (var k = Registry.CurrentUser.OpenSubKey(entry)) if (k != null) location = k.GetValue("InstallLocation") as string;
                    if (location != null && string.Equals(location.TrimEnd('\\'), root.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                        Registry.CurrentUser.DeleteSubKeyTree(entry, false);
                }
                catch { }
                Progress(0.6, null);
                Step(L("Удаляю файлы", "Deleting files"), root);
                for (int attempt = 0; attempt < 5 && Directory.Exists(root); attempt++)
                {
                    try { Directory.Delete(root, true); }
                    catch (Exception ex) { if (attempt == 4) problems.Add(L("папка: ", "folder: ") + ex.Message); Thread.Sleep(1500); }
                }
                Progress(1, null);
                Ui(() =>
                {
                    busy = false; StartReactor(0.6);
                    F<TextBlock>("DoneTitle").Text = problems.Count == 0 ? L("J.A.R.V.I.S. удалён.", "J.A.R.V.I.S. removed.") : L("Удалено, но не всё.", "Removed, but not everything.");
                    F<TextBlock>("DoneText").Text = problems.Count == 0 ? L("Всего доброго, сэр.", "Goodbye, sir.") : L("Не получилось:\n• ", "Failed:\n• ") + string.Join("\n• ", problems) + L("\nУдалите остатки вручную.", "\nRemove the leftovers by hand.");
                    Show("PageDone");
                });
            }) { IsBackground = true }.Start();
        }
    }
}
