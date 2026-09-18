import AppKit
import ApplicationServices
import Foundation

struct Options {
    var daemon = "http://127.0.0.1:4317"
    var tokenFile = ".data/access-token"
}

func options() -> Options {
    var result = Options()
    var index = 1
    while index < CommandLine.arguments.count {
        if CommandLine.arguments[index] == "--daemon", index + 1 < CommandLine.arguments.count {
            result.daemon = CommandLine.arguments[index + 1]
            index += 2
        } else if CommandLine.arguments[index] == "--token-file", index + 1 < CommandLine.arguments.count {
            result.tokenFile = CommandLine.arguments[index + 1]
            index += 2
        } else { index += 1 }
    }
    return result
}

func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name, &value) == .success ? value : nil
}

func strings(in element: AXUIElement, depth: Int = 0) -> [String] {
    if depth > 7 { return [] }
    var result: [String] = []
    for key in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
        if let text = attribute(element, key) as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            result.append(text.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }
    if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
        for child in children { result.append(contentsOf: strings(in: child, depth: depth + 1)) }
    }
    return result
}

func post(daemon: String, token: String, title: String, body: String) {
    guard let url = URL(string: daemon + "/api/triggers/system-notification") else { return }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["app": "macOS", "title": title, "body": body])
    URLSession.shared.dataTask(with: request).resume()
}

let configuration = options()
let token = (try? String(contentsOfFile: configuration.tokenFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
guard !token.isEmpty else {
    FileHandle.standardError.write(Data("Could not read access token at \(configuration.tokenFile)\n".utf8))
    exit(1)
}

let permission = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
guard AXIsProcessTrustedWithOptions(permission) else {
    FileHandle.standardError.write(Data("Accessibility permission is required. Grant it, then restart this watcher.\n".utf8))
    exit(2)
}

var seen = Set<String>()
print("Watching visible macOS Notification Center banners…")
while true {
    autoreleasepool {
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.notificationcenterui")
        guard let app = apps.first else { return }
        let root = AXUIElementCreateApplication(app.processIdentifier)
        guard let windows = attribute(root, kAXWindowsAttribute) as? [AXUIElement] else { return }
        var current = Set<String>()
        for window in windows {
            let values = Array(NSOrderedSet(array: strings(in: window))) as? [String] ?? []
            guard !values.isEmpty else { continue }
            let title = values[0]
            let body = values.dropFirst().joined(separator: " · ")
            let fingerprint = title + "\n" + body
            current.insert(fingerprint)
            if !seen.contains(fingerprint) { post(daemon: configuration.daemon, token: token, title: title, body: body) }
        }
        seen = current
    }
    Thread.sleep(forTimeInterval: 1.0)
}
