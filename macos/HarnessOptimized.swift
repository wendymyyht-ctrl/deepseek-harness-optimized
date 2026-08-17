import Cocoa
import WebKit

final class HarnessAppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var harnessProcess: Process?
    private var outputPipe: Pipe?
    private var outputBuffer = ""
    private var serverURL: URL?
    private var recentOutput: [String] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureMenu()
        configureWindow()
        showStatus(title: "Starting DeepSeek Harness…", detail: "Preparing the local runtime. Your credentials stay on this Mac.")
        startHarness()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        if let process = harnessProcess, process.isRunning {
            process.terminate()
        }
    }

    private func configureMenu() {
        let mainMenu = NSMenu()
        let applicationItem = NSMenuItem()
        mainMenu.addItem(applicationItem)
        let applicationMenu = NSMenu()
        applicationMenu.addItem(withTitle: "About DeepSeek Harness Optimized", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        applicationMenu.addItem(NSMenuItem.separator())
        applicationMenu.addItem(withTitle: "Quit DeepSeek Harness Optimized", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        applicationItem.submenu = applicationMenu
        NSApp.mainMenu = mainMenu
    }

    private func configureWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1320, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "DeepSeek Harness Optimized"
        window.titlebarAppearsTransparent = true
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("DeepSeekHarnessOptimizedMainWindow")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func startHarness() {
        guard let resources = Bundle.main.resourceURL else {
            showFailure("The application resources could not be located.")
            return
        }
        let node = resources.appendingPathComponent("runtime/bin/node")
        let appRoot = resources.appendingPathComponent("app")
        let server = appRoot.appendingPathComponent("scripts/app-server.mjs")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: server.path) else {
            showFailure("The bundled runtime is incomplete. Download the application again.")
            return
        }

        let process = Process()
        let pipe = Pipe()
        process.executableURL = node
        process.arguments = [server.path]
        process.currentDirectoryURL = appRoot
        process.standardOutput = pipe
        process.standardError = pipe
        var environment = ProcessInfo.processInfo.environment
        if environment["DSH_HOME"]?.isEmpty != false {
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            environment["DSH_HOME"] = support.appendingPathComponent("DeepSeek Harness Optimized", isDirectory: true).path
        }
        environment["DSH_APP_MODE"] = "1"
        process.environment = environment

        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.consumeOutput(text) }
        }
        process.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async {
                self?.processStopped(status: finished.terminationStatus)
            }
        }

        do {
            try process.run()
            harnessProcess = process
            outputPipe = pipe
        } catch {
            showFailure("Unable to start the bundled runtime: \(error.localizedDescription)")
        }
    }

    private func consumeOutput(_ text: String) {
        FileHandle.standardOutput.write(Data(text.utf8))
        outputBuffer += text
        let lines = outputBuffer.components(separatedBy: .newlines)
        outputBuffer = lines.last ?? ""
        for line in lines.dropLast() where !line.isEmpty {
            recentOutput.append(line)
            recentOutput = Array(recentOutput.suffix(20))
            if serverURL == nil, let range = line.range(of: #"http://127\.0\.0\.1:[0-9]+"#, options: .regularExpression),
               let url = URL(string: String(line[range])) {
                serverURL = url
                window.title = "DeepSeek Harness Optimized"
                webView.load(URLRequest(url: url))
            }
        }
    }

    private func processStopped(status: Int32) {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        if serverURL != nil && NSApp.isRunning == false { return }
        let detail = recentOutput.suffix(8).joined(separator: "\n")
        showFailure("The local Harness process stopped (status \(status)).\n\n\(detail)")
    }

    private func showStatus(title: String, detail: String) {
        let html = """
        <!doctype html><meta charset="utf-8">
        <style>
        :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
        body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1020; color: #f7f9ff; }
        main { max-width: 560px; padding: 44px; text-align: center; }
        .mark { width: 68px; height: 68px; margin: auto; border-radius: 19px; display: grid; place-items: center; background: linear-gradient(145deg,#3078ff,#8d5cff); font: 700 28px ui-monospace; box-shadow: 0 18px 50px #0008; }
        h1 { margin: 24px 0 10px; font-size: 25px; } p { color: #b8c2dc; line-height: 1.55; }
        </style><main><div class="mark">H&lt;/&gt;</div><h1>\(escapeHTML(title))</h1><p>\(escapeHTML(detail))</p></main>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func showFailure(_ message: String) {
        showStatus(title: "Unable to start", detail: message)
        window.title = "DeepSeek Harness Optimized — Error"
    }

    private func escapeHTML(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "\n", with: "<br>")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.scheme == "about" || (url.host == serverURL?.host && url.port == serverURL?.port) {
            decisionHandler(.allow)
        } else if navigationAction.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.allow)
        }
    }
}

let application = NSApplication.shared
let delegate = HarnessAppDelegate()
application.setActivationPolicy(.regular)
application.delegate = delegate
application.run()
