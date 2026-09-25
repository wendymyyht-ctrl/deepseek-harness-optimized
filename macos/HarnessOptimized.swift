import Cocoa
import WebKit

private struct EmailAccountRecord: Codable {
    let email: String
    let provider: String
}

private struct EmailAccountDocument: Codable {
    var accounts: [EmailAccountRecord]
}

private struct HarnessAppError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

private let emailKeychainService = "DeepSeek Harness Optimized Email Authorization Code"

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
        applicationMenu.addItem(withTitle: "Email Account Settings…", action: #selector(showEmailAccountSettings(_:)), keyEquivalent: ",")
        applicationMenu.addItem(NSMenuItem.separator())
        applicationMenu.addItem(withTitle: "Quit DeepSeek Harness Optimized", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        applicationItem.submenu = applicationMenu
        NSApp.mainMenu = mainMenu
    }

    private var runtimeHome: URL {
        if let configured = ProcessInfo.processInfo.environment["DSH_HOME"], !configured.isEmpty {
            return URL(fileURLWithPath: configured, isDirectory: true)
        }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("DeepSeek Harness Optimized", isDirectory: true)
    }

    @objc private func showEmailAccountSettings(_ sender: Any?) {
        let provider = NSPopUpButton(frame: .zero, pullsDown: false)
        provider.addItems(withTitles: ["QQ Mail", "NetEase Mail (163/126/yeah)"])

        let email = NSTextField()
        email.placeholderString = "name@qq.com or name@163.com"

        let authorizationCode = NSSecureTextField()
        authorizationCode.placeholderString = "IMAP/SMTP authorization code (not the web password)"

        let grid = NSGridView(views: [
            [NSTextField(labelWithString: "Provider"), provider],
            [NSTextField(labelWithString: "Email"), email],
            [NSTextField(labelWithString: "Authorization code"), authorizationCode],
        ])
        grid.rowSpacing = 12
        grid.columnSpacing = 12
        grid.column(at: 0).xPlacement = .trailing
        grid.column(at: 1).width = 320
        grid.frame = NSRect(x: 0, y: 0, width: 460, height: 112)

        let alert = NSAlert()
        alert.messageText = "Add or update an email account"
        alert.informativeText = "Enable IMAP/SMTP in the provider website first. The authorization code is saved only in macOS Keychain; it is never written to the app profile, conversation, or repository."
        alert.accessoryView = grid
        alert.addButton(withTitle: "Save securely")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        do {
            let providerID = provider.indexOfSelectedItem == 0 ? "qq" : "netease"
            let normalizedEmail = email.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let code = authorizationCode.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            try validateEmailAccount(email: normalizedEmail, provider: providerID, authorizationCode: code)
            try saveEmailAuthorizationCode(code, for: normalizedEmail)
            try saveEmailAccountRecord(email: normalizedEmail, provider: providerID)

            let success = NSAlert()
            success.messageText = "Email account saved"
            success.informativeText = "The account is ready for local IMAP/SMTP tools. Restart the app before using it."
            success.addButton(withTitle: "Done")
            success.runModal()
        } catch {
            let failure = NSAlert()
            failure.alertStyle = .warning
            failure.messageText = "Unable to save the email account"
            failure.informativeText = error.localizedDescription
            failure.addButton(withTitle: "Close")
            failure.runModal()
        }
    }

    private func validateEmailAccount(email: String, provider: String, authorizationCode: String) throws {
        guard let at = email.lastIndex(of: "@"), at != email.startIndex else {
            throw HarnessAppError("Enter a complete email address.")
        }
        let domain = String(email[email.index(after: at)...])
        let allowedDomains = provider == "qq"
            ? ["qq.com", "foxmail.com", "vip.qq.com"]
            : ["163.com", "126.com", "yeah.net"]
        guard allowedDomains.contains(domain) else {
            throw HarnessAppError("The address domain does not match the selected provider.")
        }
        guard authorizationCode.count >= 6, authorizationCode.count <= 128,
              authorizationCode.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else {
            throw HarnessAppError("Enter the provider-generated client authorization code, not the web password.")
        }
    }

    private func saveEmailAuthorizationCode(_ authorizationCode: String, for email: String) throws {
        let process = Process()
        let input = Pipe()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = [
            "add-generic-password", "-U", "-a", email, "-s", emailKeychainService,
            "-l", "DeepSeek Harness Optimized email authorization code (\(email))", "-w",
        ]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = output
        try process.run()
        try input.fileHandleForWriting.write(contentsOf: Data("\(authorizationCode)\n\(authorizationCode)\n".utf8))
        try input.fileHandleForWriting.close()
        process.waitUntilExit()
        let response = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        guard process.terminationStatus == 0 else {
            throw HarnessAppError("Unable to write macOS Keychain: \(response)")
        }
    }

    private func saveEmailAccountRecord(email: String, provider: String) throws {
        let accountsURL = runtimeHome.appendingPathComponent("integrations/email/accounts.json")
        let directory = accountsURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        var document = EmailAccountDocument(accounts: [])
        if FileManager.default.fileExists(atPath: accountsURL.path) {
            document = try JSONDecoder().decode(EmailAccountDocument.self, from: Data(contentsOf: accountsURL))
        }
        document.accounts.removeAll { $0.email.caseInsensitiveCompare(email) == .orderedSame }
        document.accounts.append(EmailAccountRecord(email: email, provider: provider))
        document.accounts.sort { $0.email.localizedCaseInsensitiveCompare($1.email) == .orderedAscending }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(document).write(to: accountsURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: accountsURL.path)
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
            if serverURL == nil, line.hasPrefix("dsh web: "), let range = line.range(of: #"http://127\.0\.0\.1:[0-9]+(?:/\?token=[A-Za-z0-9_-]+)?"#, options: .regularExpression),
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
