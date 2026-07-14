import Foundation
import Security

enum KeychainSessionStore {
    private static let service = "au.pintpath.beermap.session"
    private static let account = "pint-path-bearer-token"
    private static let supabaseRefreshAccount = "supabase-refresh-token"
    private static let supabaseAccessAccount = "supabase-access-token"

    static func loadToken() -> String? {
        load(account: account)
    }

    static func loadSupabaseRefreshToken() -> String? {
        load(account: supabaseRefreshAccount)
    }

    static func loadSupabaseAccessToken() -> String? {
        load(account: supabaseAccessAccount)
    }

    private static func load(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    static func saveToken(_ token: String) {
        save(token, account: account)
    }

    static func saveSupabaseRefreshToken(_ token: String?) {
        guard let token, !token.isEmpty else {
            delete(account: supabaseRefreshAccount)
            return
        }
        save(token, account: supabaseRefreshAccount)
    }

    static func saveSupabaseAccessToken(_ token: String?) {
        guard let token, !token.isEmpty else {
            delete(account: supabaseAccessAccount)
            return
        }
        save(token, account: supabaseAccessAccount)
    }

    private static func save(_ token: String, account: String) {
        delete(account: account)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: Data(token.utf8)
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    static func deleteToken() {
        delete(account: account)
        delete(account: supabaseRefreshAccount)
        delete(account: supabaseAccessAccount)
    }

    private static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }
}
