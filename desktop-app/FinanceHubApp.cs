using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace FinanceHub
{
    internal static class Native
    {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern int SetCurrentProcessExplicitAppUserModelID(string appID);
    }

    internal static class Program
    {
        public const string AppUserModelId = "FinanceDigest.Hub";
        public const string HubUrl = "http://127.0.0.1:8787/apps/hub/screens.html";
        public const string HealthUrl = "http://127.0.0.1:8787/api/health";

        [STAThread]
        private static void Main()
        {
            Native.SetCurrentProcessExplicitAppUserModelID(AppUserModelId);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new HubForm());
        }
    }

    internal sealed class HubForm : Form
    {
        private readonly WebView2 _web = new WebView2();
        private Process _server;
        private readonly string _root;

        public HubForm()
        {
            _root = FindProjectRoot();
            Text = "Finance Hub";
            Width = 980;
            Height = 780;
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(720, 560);
            BackColor = Color.FromArgb(11, 15, 20);
            ForeColor = Color.White;

            var iconPath = Path.Combine(_root, "desktop-app", "FinanceHub.ico");
            if (File.Exists(iconPath))
            {
                try { Icon = new Icon(iconPath); }
                catch { /* keep default */ }
            }

            _web.Dock = DockStyle.Fill;
            Controls.Add(_web);

            Load += async (sender, args) =>
            {
                try
                {
                    EnsureServer();
                    if (!WaitForHealth(TimeSpan.FromSeconds(25)))
                    {
                        MessageBox.Show(
                            this,
                            "The hub server did not start.\n\nCheck that Node.js is installed, then try again.",
                            "Finance Hub",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Error);
                        Close();
                        return;
                    }

                    var profile = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "FinanceDigestHub",
                        "WebView2");
                    Directory.CreateDirectory(profile);
                    var env = await CoreWebView2Environment.CreateAsync(null, profile);
                    await _web.EnsureCoreWebView2Async(env);
                    _web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
                    _web.CoreWebView2.Settings.AreDevToolsEnabled = false;
                    _web.CoreWebView2.Navigate(Program.HubUrl);
                }
                catch (Exception ex)
                {
                    MessageBox.Show(
                        this,
                        "Could not open Finance Hub:\n\n" + ex.Message,
                        "Finance Hub",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                    Close();
                }
            };

            FormClosed += (sender, args) => StopServerIfOwned();
        }

        private static string FindProjectRoot()
        {
            var dir = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
            while (dir != null)
            {
                if (File.Exists(Path.Combine(dir.FullName, "hub", "server.js")))
                    return dir.FullName;
                dir = dir.Parent;
            }
            return AppDomain.CurrentDomain.BaseDirectory;
        }

        private void EnsureServer()
        {
            if (IsHealthy()) return;

            var node = FindNode();
            if (node == null)
                throw new InvalidOperationException("Node.js was not found on PATH.");

            var psi = new ProcessStartInfo
            {
                FileName = node,
                Arguments = "hub\\server.js",
                WorkingDirectory = _root,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            _server = Process.Start(psi);
            if (_server == null)
                throw new InvalidOperationException("Failed to start hub\\server.js.");
        }

        private static string FindNode()
        {
            var path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (var part in path.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
            {
                try
                {
                    var candidate = Path.Combine(part.Trim('"'), "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch { /* ignore bad PATH entries */ }
            }
            var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            foreach (var candidate in new[]
            {
                Path.Combine(pf, "nodejs", "node.exe"),
                Path.Combine(local, "Programs", "node", "node.exe")
            })
            {
                if (File.Exists(candidate)) return candidate;
            }
            return null;
        }

        private static bool IsHealthy()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(Program.HealthUrl);
                req.Timeout = 1000;
                req.Method = "GET";
                using (var res = (HttpWebResponse)req.GetResponse())
                    return (int)res.StatusCode == 200;
            }
            catch
            {
                return false;
            }
        }

        private static bool WaitForHealth(TimeSpan timeout)
        {
            var deadline = DateTime.UtcNow + timeout;
            while (DateTime.UtcNow < deadline)
            {
                if (IsHealthy()) return true;
                Thread.Sleep(250);
            }
            return false;
        }

        private void StopServerIfOwned()
        {
            if (_server == null) return;
            try
            {
                if (!_server.HasExited)
                {
                    _server.Kill();
                    _server.WaitForExit(3000);
                }
            }
            catch { /* ignore */ }
            finally
            {
                _server.Dispose();
                _server = null;
            }
        }
    }
}
