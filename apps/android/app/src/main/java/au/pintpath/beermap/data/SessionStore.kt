package au.pintpath.beermap.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class PendingOAuthState(
    val codeVerifier: String
)

class SessionStore(context: Context) {
    private companion object {
        const val COOKIE_CREDENTIAL_PREFIX = "cookie-v1:"
        const val LOCAL_BEARER_CREDENTIAL_PREFIX = "local-bearer-v1:"
        val SESSION_COOKIE_VALUE_PATTERN = Regex(
            "^(?:[A-Za-z0-9_-]{43}|credential-v1\\.(?:session_management|account_export|account_deletion|billing_portal|venue_billing_portal|logout_all)\\.[1-9][0-9]{0,10}\\.[A-Za-z0-9_-]{43})$"
        )
        val LEGACY_BEARER_PATTERN = Regex("^[A-Za-z0-9_-]{43}$")
    }

    private val preferences = context.getSharedPreferences("beermap_session", Context.MODE_PRIVATE)
    private val keyAlias = "au.pintpath.beermap.session.aes"

    fun loadToken(): String? {
        loadEncrypted("bearer_token")?.let { return it }

        // One-time migration from the previous app-private plaintext preference.
        val legacy = preferences.getString("bearer_token", null)
        if (!legacy.isNullOrBlank()) {
            saveToken(legacy)
            return legacy
        }
        return null
    }

    fun saveToken(token: String) {
        saveEncrypted("bearer_token", token)
        preferences.edit().remove("bearer_token").commit()
    }

    fun saveSessionCookie(value: String): Boolean {
        if (!SESSION_COOKIE_VALUE_PATTERN.matches(value)) return false
        saveToken("$COOKIE_CREDENTIAL_PREFIX$value")
        return true
    }

    fun cookieValue(credential: String): String? {
        if (!credential.startsWith(COOKIE_CREDENTIAL_PREFIX)) return null
        return credential.removePrefix(COOKIE_CREDENTIAL_PREFIX)
            .takeIf(SESSION_COOKIE_VALUE_PATTERN::matches)
    }

    fun saveLocalBearerToken(value: String): Boolean {
        if (!LEGACY_BEARER_PATTERN.matches(value)) return false
        saveToken("$LOCAL_BEARER_CREDENTIAL_PREFIX$value")
        return true
    }

    fun localBearerToken(credential: String): String? {
        if (!credential.startsWith(LOCAL_BEARER_CREDENTIAL_PREFIX)) return null
        return credential.removePrefix(LOCAL_BEARER_CREDENTIAL_PREFIX)
            .takeIf(LEGACY_BEARER_PATTERN::matches)
    }

    fun legacyBearerToken(credential: String): String? = credential
        .takeUnless {
            it.startsWith(COOKIE_CREDENTIAL_PREFIX) ||
                it.startsWith(LOCAL_BEARER_CREDENTIAL_PREFIX)
        }
        ?.takeIf(LEGACY_BEARER_PATTERN::matches)

    fun loadSupabaseRefreshToken(): String? = loadEncrypted("supabase_refresh_token")

    fun saveSupabaseRefreshToken(token: String?) {
        if (token.isNullOrBlank()) clearEncrypted("supabase_refresh_token")
        else saveEncrypted("supabase_refresh_token", token)
    }

    fun loadSupabaseAccessToken(): String? = loadEncrypted("supabase_access_token")

    fun saveSupabaseAccessToken(token: String?) {
        if (token.isNullOrBlank()) clearEncrypted("supabase_access_token")
        else saveEncrypted("supabase_access_token", token)
    }

    private fun saveEncrypted(prefix: String, token: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val encrypted = cipher.doFinal(token.toByteArray(StandardCharsets.UTF_8))
        preferences.edit()
            .putString("${prefix}_encrypted", Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .putString("${prefix}_iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .commit()
    }

    fun clearToken() {
        preferences.edit()
            .remove("bearer_token")
            .remove("bearer_token_encrypted")
            .remove("bearer_token_iv")
            .remove("supabase_refresh_token_encrypted")
            .remove("supabase_refresh_token_iv")
            .remove("supabase_access_token_encrypted")
            .remove("supabase_access_token_iv")
            .commit()
        clearPendingOAuth()
    }

    private fun loadEncrypted(prefix: String): String? {
        val encrypted = preferences.getString("${prefix}_encrypted", null)
        val iv = preferences.getString("${prefix}_iv", null)
        if (encrypted.isNullOrBlank() || iv.isNullOrBlank()) return null
        return runCatching { decrypt(encrypted, iv) }.getOrElse {
            clearEncrypted(prefix)
            null
        }
    }

    private fun clearEncrypted(prefix: String) {
        preferences.edit()
            .remove("${prefix}_encrypted")
            .remove("${prefix}_iv")
            .commit()
    }

    fun anonymousSessionId(): String {
        val existing = preferences.getString("anonymous_session_id", null)
        if (!existing.isNullOrBlank()) return existing
        val generated = UUID.randomUUID().toString()
        preferences.edit().putString("anonymous_session_id", generated).apply()
        return generated
    }

    fun savePendingOAuth(state: PendingOAuthState) {
        saveEncrypted("pending_oauth_code_verifier", state.codeVerifier)
        preferences.edit()
            .remove("pending_oauth_age")
            .remove("pending_oauth_terms")
            .remove("pending_oauth_privacy")
            .putLong("pending_oauth_created_at", System.currentTimeMillis())
            .commit()
    }

    fun loadPendingOAuth(): PendingOAuthState? {
        val codeVerifier = loadEncrypted("pending_oauth_code_verifier")?.takeIf { it.isNotBlank() } ?: return null
        val createdAt = preferences.getLong("pending_oauth_created_at", 0L)
        if (createdAt <= 0L || System.currentTimeMillis() - createdAt > 10 * 60_000L) {
            clearPendingOAuth()
            return null
        }
        return PendingOAuthState(codeVerifier = codeVerifier)
    }

    fun clearPendingOAuth() {
        preferences.edit()
            .remove("pending_oauth_state")
            .remove("pending_oauth_age")
            .remove("pending_oauth_terms")
            .remove("pending_oauth_privacy")
            .remove("pending_oauth_created_at")
            .commit()
        clearEncrypted("pending_oauth_code_verifier")
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(keyAlias, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .setUserAuthenticationRequired(false)
                .build()
        )
        return generator.generateKey()
    }

    private fun decrypt(ciphertext: String, iv: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            getOrCreateKey(),
            GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP))
        )
        val clear = cipher.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP))
        return String(clear, StandardCharsets.UTF_8)
    }
}
