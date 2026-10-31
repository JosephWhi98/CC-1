import Cocoa
import WebKit
import UserNotifications

let port = 47470
let defaultRoot = NSString(string: "~/Documents/Development/Claude Projects").expandingTildeInPath

final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?
    var retries = 0
    let url = URL(string: "http://127.0.0.1:\(port)")!

    func applicationDidFinishLaunching(_ n: Notification) {
        buildMenu()
        startServer()

        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "pickFolder")
        cfg.userContentController.add(self, name: "cc1Theme")
        cfg.userContentController.add(self, name: "cc1Notify")
        cfg.userContentController.add(self, name: "cc1Update")
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = false
        window.backgroundColor = NSColor(red: 0.788, green: 0.776, blue: 0.749, alpha: 1)
        if let saved = UserDefaults.standard.dictionary(forKey: "theme") { applyTheme(saved) }   // avoid a flash of the wrong colour at launch
        window.minSize = NSSize(width: 1000, height: 640)
        window.contentView = web
        window.setFrameAutosaveName("CC1Main")
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        load()
    }

    func load() { web.load(URLRequest(url: url)) }

    func startServer() {
        guard let res = Bundle.main.resourcePath else { return }
        let fm = FileManager.default
        let home = NSHomeDirectory()
        // nvm installs live under a per-version folder; try the newest first
        let nvm = ((try? fm.contentsOfDirectory(atPath: home + "/.nvm/versions/node")) ?? []).sorted { $0.compare($1, options: .numeric) == .orderedDescending }.map { "\(home)/.nvm/versions/node/\($0)/bin/node" }
        let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", home + "/.volta/bin/node", home + "/.local/bin/node"] + nvm
        // a node that exists but won't run (e.g. Homebrew upgraded a library it links to) must be skipped, not used
        guard let nodePath = candidates.first(where: { fm.isExecutableFile(atPath: $0) && nodeRuns($0) }) else {
            let broken = candidates.first { fm.isExecutableFile(atPath: $0) }
            alert(broken == nil ? "Node.js not found" : "Node.js is installed but won't run", broken == nil ? "Install Node (brew install node) and relaunch." : "\(broken!) failed to start. Try: brew reinstall node")
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodePath)
        p.arguments = [res + "/server.js"]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", env["PATH"] ?? ""].joined(separator: ":")
        env["PORT"] = String(port)
        env["PROJECTS_ROOT"] = defaultRoot
        p.environment = env
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { q in
            if q.terminationStatus != 0 && q.terminationReason == .exit { DispatchQueue.main.async { self.alert("The CC-1 server stopped", "node exited with code \(q.terminationStatus). Try relaunching CC-1.") } }
        }
        do { try p.run(); server = p } catch { alert("Could not start server", "\(error)") }
    }

    func nodeRuns(_ path: String) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path); p.arguments = ["-v"]
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice; p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }

    func webView(_ w: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError e: Error) {
        // server still booting
        retries += 1
        if retries < 40 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.load() } }
    }

    // open external links in the default browser
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = a.request.url, u.host != "127.0.0.1", a.navigationType == .linkActivated {
            NSWorkspace.shared.open(u); decisionHandler(.cancel)
        } else { decisionHandler(.allow) }
    }

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        if m.name == "pickFolder" { pickFolder() }
        if m.name == "cc1Notify", let d = m.body as? [String: Any] {
            let n = UNMutableNotificationContent(); n.title = d["title"] as? String ?? "CC-1"; n.body = d["body"] as? String ?? ""; n.sound = .default
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: n, trigger: nil))
        }
        if m.name == "cc1Update", let d = m.body as? [String: Any], let stage = d["stage"] as? String { installUpdate(stage) }
        if m.name == "cc1Theme", let d = m.body as? [String: Any] { applyTheme(d); UserDefaults.standard.set(d, forKey: "theme") }
    }

    func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil); done()
    }

    // Hands the staged update (unpacked by server.js) to update.sh, which swaps the bundle after we quit and relaunches.
    func installUpdate(_ stage: String) {
        func fail(_ msg: String) {
            let j = String(data: try! JSONSerialization.data(withJSONObject: [msg]), encoding: .utf8)!
            web.evaluateJavaScript("window.cc1UpdateFail && cc1UpdateFail(" + j + "[0])", completionHandler: nil)
        }
        let fm = FileManager.default, appPath = Bundle.main.bundlePath
        guard (stage as NSString).standardizingPath.hasPrefix(NSHomeDirectory() + "/.cc-1/update/"),
              fm.fileExists(atPath: stage + "/CC-1.app/Contents/Info.plist") else { return fail("update package not found") }
        guard appPath.hasSuffix(".app"), fm.isWritableFile(atPath: (appPath as NSString).deletingLastPathComponent) else {
            return fail("CC-1 is in a folder it can't change. Move it to Applications, or download the update manually.")
        }
        guard let script = Bundle.main.path(forResource: "update", ofType: "sh") else { return fail("updater script missing") }
        let tmp = NSTemporaryDirectory() + "cc1-update.sh"
        try? fm.removeItem(atPath: tmp)
        do { try fm.copyItem(atPath: script, toPath: tmp) } catch { return fail("\(error.localizedDescription)") }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [tmp, String(ProcessInfo.processInfo.processIdentifier), stage, appPath]
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice; p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return fail("\(error.localizedDescription)") }
        NSApp.terminate(nil)
    }

    // The window background shows through the transparent title bar, so painting it matches the bar to the theme.
    func applyTheme(_ d: [String: Any]) {
        guard let hex = d["bg"] as? String, hex.count == 7, let n = UInt32(hex.dropFirst(), radix: 16) else { return }
        window.backgroundColor = NSColor(red: CGFloat((n >> 16) & 255) / 255, green: CGFloat((n >> 8) & 255) / 255, blue: CGFloat(n & 255) / 255, alpha: 1)
        window.appearance = NSAppearance(named: (d["dark"] as? Bool ?? false) ? .darkAqua : .aqua)
    }

    func pickFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true
        panel.prompt = "Add"; panel.message = "Choose a project folder"
        panel.beginSheetModal(for: window) { r in
            guard r == .OK, let u = panel.url else { return }
            let js = "window.cc1Picked(" + (String(data: try! JSONSerialization.data(withJSONObject: [u.path]), encoding: .utf8)!) + "[0])"
            self.web.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    @objc func reload() { web.reload() }
    @objc func pickRoot() { pickFolder() }
    @objc func openSettings() { web.evaluateJavaScript("document.querySelector('#btnSet').click()", completionHandler: nil) }
    @objc func newSession() { web.evaluateJavaScript("document.querySelector('#btnNewS').click()", completionHandler: nil) }

    func buildMenu() {
        let main = NSMenu()
        func item(_ title: String, _ sel: Selector?, _ key: String = "", target: AnyObject? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: sel, keyEquivalent: key); i.target = target; return i
        }
        let appMenu = NSMenu()
        appMenu.addItem(item("About CC-1", #selector(NSApplication.orderFrontStandardAboutPanel(_:))))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Settings…", #selector(openSettings), ",", target: self))
        appMenu.addItem(item("New Session", #selector(newSession), "n", target: self))
        appMenu.addItem(item("Add Project Folder…", #selector(pickRoot), "o", target: self))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Hide CC-1", #selector(NSApplication.hide(_:)), "h"))
        appMenu.addItem(item("Quit CC-1", #selector(NSApplication.terminate(_:)), "q"))
        let a = NSMenuItem(); a.submenu = appMenu; main.addItem(a)

        let edit = NSMenu(title: "Edit")
        edit.addItem(item("Undo", Selector(("undo:")), "z"))
        edit.addItem(item("Redo", Selector(("redo:")), "Z"))
        edit.addItem(.separator())
        edit.addItem(item("Cut", #selector(NSText.cut(_:)), "x"))
        edit.addItem(item("Copy", #selector(NSText.copy(_:)), "c"))
        edit.addItem(item("Paste", #selector(NSText.paste(_:)), "v"))
        edit.addItem(item("Select All", #selector(NSText.selectAll(_:)), "a"))
        let e = NSMenuItem(); e.submenu = edit; main.addItem(e)

        let view = NSMenu(title: "View")
        view.addItem(item("Reload", #selector(reload), "r", target: self))
        view.addItem(item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f"))
        let v = NSMenuItem(); v.submenu = view; main.addItem(v)
        NSApp.mainMenu = main
    }

    func alert(_ t: String, _ m: String) { let a = NSAlert(); a.messageText = t; a.informativeText = m; a.runModal() }
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ n: Notification) { server?.terminate() }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
