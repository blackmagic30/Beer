import Foundation
import Security

enum KeychainSessionStore {
    private static let service = "au.pintpath.app.session"
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

    @discardableResult
    static func saveToken(_ token: String) -> Bool {
        save(token, account: account)
    }

    @discardableResult
    static func saveSupabaseRefreshToken(_ token: String?) -> Bool {
        guard let token, !token.isEmpty else {
            return delete(account: supabaseRefreshAccount)
        }
        return save(token, account: supabaseRefreshAccount)
    }

    @discardableResult
    static func saveSupabaseAccessToken(_ token: String?) -> Bool {
        guard let token, !token.isEmpty else {
            return delete(account: supabaseAccessAccount)
        }
        return save(token, account: supabaseAccessAccount)
    }

    private static func save(_ token: String, account: String) -> Bool {
        let lookup: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let update: [String: Any] = [
            kSecValueData as String: Data(token.utf8)
        ]
        let updateStatus = SecItemUpdate(lookup as CFDictionary, update as CFDictionary)
        if updateStatus == errSecSuccess {
            return true
        }
        guard updateStatus == errSecItemNotFound else {
            return false
        }

        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: Data(token.utf8)
        ]
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        if addStatus == errSecSuccess {
            return true
        }
        if addStatus == errSecDuplicateItem {
            return SecItemUpdate(lookup as CFDictionary, update as CFDictionary) == errSecSuccess
        }
        return false
    }

    static func deleteToken() {
        delete(account: account)
        delete(account: supabaseRefreshAccount)
        delete(account: supabaseAccessAccount)
    }

    @discardableResult
    private static func delete(account: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
