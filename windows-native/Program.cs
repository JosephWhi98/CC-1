// CC-1 for Windows: a small native WinForms shell around WebView2. Same local server + UI as the Mac app.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace CC1
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            bool first;
            using (var mutex = new Mutex(true, "Local\\CC1.Main", out first))
            {
                var show = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\CC1.Show");
                if (!first) { show.Set(); return; }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm(show));
            }
        }
    }

    // Kills the server (and the claude processes under it) when CC-1 exits, even if CC-1 crashes.
    static class KillOnClose
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
        [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
        [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [StructLayout(LayoutKind.Sequential)]
        struct Basic { public long PerProcess, PerJob; public uint Flags; public UIntPtr MinWs, MaxWs; public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling; }
        [StructLayout(LayoutKind.Sequential)]
        struct IoCounters { public ulong a, b, c, d, e, f; }
        [StructLayout(LayoutKind.Sequential)]
        struct Extended { public Basic B; public IoCounters Io; public UIntPtr ProcMem, JobMem, PeakProc, PeakJob; }

        static IntPtr job;
        public static void Add(Process p)
        {
            try
            {
                if (job == IntPtr.Zero)
                {
                    job = CreateJobObject(IntPtr.Zero, null);
                    var info = new Extended();
                    info.B.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    int size = Marshal.SizeOf(typeof(Extended));
                    IntPtr mem = Marshal.AllocHGlobal(size);
                    Marshal.StructureToPtr(info, mem, false);
                    SetInformationJobObject(job, 9, mem, (uint)size);
                    Marshal.FreeHGlobal(mem);
                }
                AssignProcessToJobObject(job, p.Handle);
            }
            catch { }
        }
    }

    sealed class MainForm : Form
    {
        const int Port = 47470;
        static readonly string Url = "http://127.0.0.1:" + Port;
        static readonly string Data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CC-1");

        // Injected into every page: exposes the same cc1Native bridge the Electron build had, plus Ctrl+O / Ctrl+N.
        const string Shim = @"(function(){
  if (window.cc1Native || !window.chrome || !chrome.webview) return;
  var pend = null, post = function(o){ chrome.webview.postMessage(JSON.stringify(o)); };
  window.cc1Native = {
    pickFolder: function(){ return new Promise(function(r){ pend = r; post({t:'pick'}); }); },
    notify: function(a,b){ post({t:'notify', title:a, body:b}); },
    theme: function(bg,dark){ post({t:'theme', bg:bg, dark:dark}); },
    update: function(stage){ post({t:'update', stage:stage}); }
  };
  window.__cc1Pick = function(p){ if (pend) { var r = pend; pend = null; r(p); } };
  addEventListener('keydown', function(e){
    if (e.key === 'F11') { e.preventDefault(); post({t:'fs'}); return; }
    if (!e.ctrlKey || e.altKey || e.shiftKey) return;
    var id = ({o:'#btnAdd', n:'#btnNewS'})[e.key.toLowerCase()];
    if (id) { e.preventDefault(); var b = document.querySelector(id); if (b) b.click(); }
  }, true);
})();";

        readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(0xc9, 0xc6, 0xbf) };
        readonly NotifyIcon tray = new NotifyIcon();
        readonly EventWaitHandle showSignal;
        Process server;
        bool fullscreen;
        FormWindowState prevState;

        public MainForm(EventWaitHandle show)
        {
            showSignal = show;
            Text = "CC-1";
            BackColor = Color.FromArgb(0xc9, 0xc6, 0xbf);
            ClientSize = new Size(1320, 860);
            MinimumSize = new Size(1000, 640);
            StartPosition = FormStartPosition.CenterScreen;
            try { using (var s = typeof(MainForm).Assembly.GetManifestResourceStream("CC-1.ico")) Icon = new Icon(s); } catch { }
            Controls.Add(web);

            tray.Icon = Icon; tray.Text = "CC-1"; tray.Visible = true;
            tray.BalloonTipClicked += (s, e) => Bring();
            tray.MouseClick += (s, e) => Bring();

            var t = new Thread(() => { while (showSignal.WaitOne()) { try { BeginInvoke((Action)Bring); } catch { return; } } }) { IsBackground = true };
            t.Start();

            Load += async (s, e) => await Boot();
            FormClosed += (s, e) => { tray.Visible = false; tray.Dispose(); StopServer(); };
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try   // avoid a flash of the wrong title-bar colour at launch
            {
                var p = Path.Combine(Data, "theme.txt");
                if (File.Exists(p)) { var parts = File.ReadAllText(p).Split(','); ApplyTheme(parts[0], parts[1] == "1"); }
            }
            catch { }
        }

        void Bring()
        {
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Show(); Activate();
        }

        // ---- server ----
        void StartServer()
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string node = Path.Combine(root, "node", "node.exe");
            string script = Path.Combine(root, "app", "server.js");
            if (!File.Exists(node) || !File.Exists(script)) { Fail("CC-1 is incomplete", "node\\node.exe or app\\server.js is missing. Re-extract the whole zip."); return; }
            var psi = new ProcessStartInfo(node, "\"" + script + "\"")
            {
                WorkingDirectory = Path.Combine(root, "app"),
                UseShellExecute = false, CreateNoWindow = true,
            };
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string appdata = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            psi.EnvironmentVariables["PATH"] = string.Join(";", new[] { Path.Combine(home, ".local", "bin"), Path.Combine(appdata, "npm") }) + ";" + Environment.GetEnvironmentVariable("PATH");
            psi.EnvironmentVariables["PORT"] = Port.ToString();
            try { server = Process.Start(psi); KillOnClose.Add(server); }
            catch (Exception ex) { Fail("Could not start the CC-1 server", ex.Message); }
        }

        void StopServer()
        {
            try
            {
                if (server != null && !server.HasExited)
                {
                    var k = Process.Start(new ProcessStartInfo("taskkill", "/PID " + server.Id + " /T /F") { CreateNoWindow = true, UseShellExecute = false });
                    k.WaitForExit(2000);
                }
            }
            catch { }
        }

        static bool ServerUp()
        {
            try { var r = (HttpWebRequest)WebRequest.Create(Url + "/api/projects"); r.Timeout = 1000; r.Proxy = null; using (r.GetResponse()) return true; }
            catch { return false; }
        }

        // ---- web view ----
        async Task Boot()
        {
            StartServer();
            try
            {
                Directory.CreateDirectory(Data);
                var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Data, "webview"));
                await web.EnsureCoreWebView2Async(env);
            }
            catch (Exception ex)
            {
                if (MessageBox.Show(this, "CC-1 needs the Microsoft Edge WebView2 Runtime, which could not be started.\n\n" + ex.Message + "\n\nOpen the download page?",
                    "WebView2 not found", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
                    Process.Start("https://developer.microsoft.com/microsoft-edge/webview2/");
                Close(); return;
            }
            var c = web.CoreWebView2;
            c.Settings.IsStatusBarEnabled = false;
            c.Settings.IsZoomControlEnabled = false;
            c.Settings.IsPinchZoomEnabled = false;
            await c.AddScriptToExecuteOnDocumentCreatedAsync(Shim);
            c.WebMessageReceived += OnMessage;
            c.NewWindowRequested += (s, e) => { e.Handled = true; OpenExternal(e.Uri); };
            c.NavigationStarting += (s, e) => { if (!e.Uri.StartsWith(Url)) { e.Cancel = true; OpenExternal(e.Uri); } };

            for (int i = 0; i < 60 && !await Task.Run((Func<bool>)ServerUp); i++) await Task.Delay(250);
            c.Navigate(Url);
        }

        static void OpenExternal(string uri)
        {
            if (uri.StartsWith("http://") || uri.StartsWith("https://")) try { Process.Start(uri); } catch { }
        }

        void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                var m = new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string, object>>(e.TryGetWebMessageAsString());
                switch ((string)m["t"])
                {
                    case "pick": PickFolder(); break;
                    case "notify": Notify(m.ContainsKey("title") ? m["title"] as string : null, m.ContainsKey("body") ? m["body"] as string : null); break;
                    case "theme":
                        var bg = (string)m["bg"]; bool dark = m["dark"] is bool && (bool)m["dark"];
                        ApplyTheme(bg, dark);
                        try { Directory.CreateDirectory(Data); File.WriteAllText(Path.Combine(Data, "theme.txt"), bg + "," + (dark ? "1" : "0")); } catch { }
                        break;
                    case "fs": ToggleFullscreen(); break;
                    case "update": InstallUpdate((string)m["stage"]); break;
                }
            }
            catch { }
        }

        // Hands the staged update (unpacked by server.js) to update.cmd, which swaps the files after we quit and relaunches.
        void InstallUpdate(string stage)
        {
            Action<string> fail = msg => web.CoreWebView2.ExecuteScriptAsync("window.cc1UpdateFail&&cc1UpdateFail(" + new JavaScriptSerializer().Serialize(msg) + ")");
            try
            {
                string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
                string allowed = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cc-1", "update") + "\\";
                if (stage == null || !Path.GetFullPath(stage).StartsWith(allowed, StringComparison.OrdinalIgnoreCase) || !File.Exists(Path.Combine(stage, "CC-1.exe"))) { fail("update package not found"); return; }
                string script = Path.Combine(root, "app", "update.cmd");
                if (!File.Exists(script)) { fail("updater script missing"); return; }
                try { string probe = Path.Combine(root, ".write-test"); File.WriteAllText(probe, "x"); File.Delete(probe); }
                catch { fail("CC-1 is in a folder it can't change (try C:\\Apps\\CC-1), or download the update manually."); return; }
                Directory.CreateDirectory(Data);
                string tmp = Path.Combine(Data, "update.cmd");
                File.Copy(script, tmp, true);
                var psi = new ProcessStartInfo("cmd.exe", "/c \"\"" + tmp + "\" " + Process.GetCurrentProcess().Id + " \"" + stage + "\" \"" + root + "\" \"" + Path.Combine(root, ".cc1-old") + "\"\"")
                { UseShellExecute = false, CreateNoWindow = true };
                Process.Start(psi);
                Close();
            }
            catch (Exception ex) { fail(ex.Message); }
        }

        void PickFolder()
        {
            // Explorer-style dialog (the stock FolderBrowserDialog is the old tree view): pick a folder by opening it.
            using (var d = new OpenFileDialog { Title = "Choose a project folder", ValidateNames = false, CheckFileExists = false, CheckPathExists = true, FileName = "Select this folder", Filter = "Folders|*.none" })
            {
                string path = d.ShowDialog(this) == DialogResult.OK ? Path.GetDirectoryName(d.FileName) : null;
                web.CoreWebView2.ExecuteScriptAsync("window.__cc1Pick(" + new JavaScriptSerializer().Serialize(path) + ")");
            }
        }

        void Notify(string title, string body)
        {
            if (ActiveForm == this && WindowState != FormWindowState.Minimized) return;
            tray.ShowBalloonTip(6000, string.IsNullOrEmpty(title) ? "CC-1" : title, string.IsNullOrEmpty(body) ? " " : body, ToolTipIcon.None);
        }

        void ToggleFullscreen()
        {
            if (!fullscreen) { prevState = WindowState; WindowState = FormWindowState.Normal; FormBorderStyle = FormBorderStyle.None; WindowState = FormWindowState.Maximized; }
            else { FormBorderStyle = FormBorderStyle.Sizable; WindowState = prevState; }
            fullscreen = !fullscreen;
        }

        // ---- title bar follows the UI theme (Windows 11; harmlessly ignored on older builds) ----
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        void ApplyTheme(string hex, bool dark)
        {
            if (hex == null || hex.Length != 7 || hex[0] != '#' || !IsHandleCreated) return;
            int n = Convert.ToInt32(hex.Substring(1), 16);
            int r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
            int bgr = r | (g << 8) | (b << 16);
            int text = dark ? 0xF0F0F0 : 0x202020;
            int on = dark ? 1 : 0;
            DwmSetWindowAttribute(Handle, 20, ref on, 4);     // immersive dark mode
            DwmSetWindowAttribute(Handle, 35, ref bgr, 4);    // caption colour
            DwmSetWindowAttribute(Handle, 34, ref bgr, 4);    // border colour
            DwmSetWindowAttribute(Handle, 36, ref text, 4);   // caption text colour
            BackColor = Color.FromArgb(r, g, b);
        }

        void Fail(string title, string msg) { MessageBox.Show(this, msg, title, MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }
}
