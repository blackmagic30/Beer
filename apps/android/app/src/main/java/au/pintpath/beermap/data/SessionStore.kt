package au.pintpath.beermap.data

import android.content.Context
import java.util.UUID

class SessionStore(context: Context) {
    private val preferences = context.getSharedPreferences("beermap_session", Context.MODE_PRIVATE)

    fun loadToken(): String? = preferences.getString("bearer_token", null)

    fun saveToken(token: String) {
        preferences.edit().putString("bearer_token", token).apply()
    }

    fun clearToken() {
        preferences.edit().remove("bearer_token").apply()
    }

    fun anonymousSessionId(): String {
        val existing = preferences.getString("anonymous_session_id", null)
        if (!existing.isNullOrBlank()) return existing
        val generated = UUID.randomUUID().toString()
        preferences.edit().putString("anonymous_session_id", generated).apply()
        return generated
    }
}

