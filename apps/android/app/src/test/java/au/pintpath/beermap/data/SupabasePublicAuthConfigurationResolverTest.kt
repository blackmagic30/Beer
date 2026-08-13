package au.pintpath.beermap.data

import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class SupabasePublicAuthConfigurationResolverTest {
    private val approvedOrigin = SupabasePublicAuthConfigurationResolver.APPROVED_ORIGIN
    private val configuredKey = "sb_publishable_${"a".repeat(32)}"
    private val embeddedKey = "sb_publishable_${"b".repeat(32)}"

    @Test
    fun `uses a complete configured pair ahead of a complete embedded pair`() {
        val resolved = SupabasePublicAuthConfigurationResolver.resolveValues(
            configuredOriginPublished = true,
            configuredOrigin = approvedOrigin,
            configuredKeyPublished = true,
            configuredKey = configuredKey,
            embeddedOrigin = approvedOrigin,
            embeddedKey = embeddedKey
        )

        assertEquals(approvedOrigin, resolved?.origin)
        assertEquals(configuredKey, resolved?.publishableKey)
    }

    @Test
    fun `uses the embedded pair only when configured values are absent`() {
        val resolved = SupabasePublicAuthConfigurationResolver.resolveValues(
            configuredOriginPublished = false,
            configuredOrigin = null,
            configuredKeyPublished = false,
            configuredKey = null,
            embeddedOrigin = approvedOrigin,
            embeddedKey = embeddedKey
        )

        assertEquals(approvedOrigin, resolved?.origin)
        assertEquals(embeddedKey, resolved?.publishableKey)
    }

    @Test
    fun `returns no configuration when both sources are absent`() {
        assertNull(
            SupabasePublicAuthConfigurationResolver.resolveValues(
                configuredOriginPublished = false,
                configuredOrigin = null,
                configuredKeyPublished = false,
                configuredKey = "",
                embeddedOrigin = "",
                embeddedKey = null
            )
        )
    }

    @Test
    fun `honors an explicit disconnected configured pair without embedded fallback`() {
        val disconnectedPairs = listOf(
            null to null,
            "" to "",
            null to "",
            "" to null
        )

        disconnectedPairs.forEach { (origin, key) ->
            assertNull(
                SupabasePublicAuthConfigurationResolver.resolveValues(
                    configuredOriginPublished = true,
                    configuredOrigin = origin,
                    configuredKeyPublished = true,
                    configuredKey = key,
                    embeddedOrigin = approvedOrigin,
                    embeddedKey = embeddedKey
                )
            )
        }
    }

    @Test
    fun `rejects one-sided configured fields without embedded fallback`() {
        val oneSidedFields = listOf(
            true to false,
            false to true
        )

        oneSidedFields.forEach { (originPublished, keyPublished) ->
            assertUnavailable(null) {
                SupabasePublicAuthConfigurationResolver.resolveValues(
                    configuredOriginPublished = originPublished,
                    configuredOrigin = approvedOrigin.takeIf { originPublished },
                    configuredKeyPublished = keyPublished,
                    configuredKey = configuredKey.takeIf { keyPublished },
                    embeddedOrigin = approvedOrigin,
                    embeddedKey = embeddedKey
                )
            }
        }
    }

    @Test
    fun `rejects every noncanonical configured origin without embedded fallback`() {
        val rejectedOrigins = listOf(
            " https://auth.pintpath.au",
            "https://auth.pintpath.au ",
            "http://auth.pintpath.au",
            "https://evil.pintpath.au",
            "https://auth.pintpath.au/",
            "https://auth.pintpath.au/auth/v1",
            "https://auth.pintpath.au?source=android",
            "https://auth.pintpath.au#fragment",
            "https://user@auth.pintpath.au",
            "https://auth.pintpath.au:443"
        )

        rejectedOrigins.forEach { rejectedOrigin ->
            assertUnavailable(rejectedOrigin) {
                SupabasePublicAuthConfigurationResolver.resolveValues(
                    configuredOriginPublished = true,
                    configuredOrigin = rejectedOrigin,
                    configuredKeyPublished = true,
                    configuredKey = configuredKey,
                    embeddedOrigin = approvedOrigin,
                    embeddedKey = embeddedKey
                )
            }
        }
    }

    @Test
    fun `rejects an incomplete or malformed configured pair without embedded fallback`() {
        val invalidPairs = listOf(
            approvedOrigin to null,
            approvedOrigin to "",
            null to configuredKey,
            "" to configuredKey,
            approvedOrigin to "sb_secret_${"s".repeat(32)}",
            approvedOrigin to "eyJhbGciOiJIUzI1NiJ9.legacy.anon",
            approvedOrigin to "not-a-supabase-key"
        )

        invalidPairs.forEach { (origin, key) ->
            assertUnavailable(key ?: origin) {
                SupabasePublicAuthConfigurationResolver.resolveValues(
                    configuredOriginPublished = true,
                    configuredOrigin = origin,
                    configuredKeyPublished = true,
                    configuredKey = key,
                    embeddedOrigin = approvedOrigin,
                    embeddedKey = embeddedKey
                )
            }
        }
    }

    @Test
    fun `rejects a noncanonical embedded pair`() {
        assertUnavailable("http://auth.pintpath.au") {
            SupabasePublicAuthConfigurationResolver.resolveValues(
                configuredOriginPublished = false,
                configuredOrigin = null,
                configuredKeyPublished = false,
                configuredKey = null,
                embeddedOrigin = "http://auth.pintpath.au",
                embeddedKey = embeddedKey
            )
        }
        assertUnavailable("sb_secret_") {
            SupabasePublicAuthConfigurationResolver.resolveValues(
                configuredOriginPublished = false,
                configuredOrigin = null,
                configuredKeyPublished = false,
                configuredKey = null,
                embeddedOrigin = approvedOrigin,
                embeddedKey = "sb_secret_${"s".repeat(32)}"
            )
        }
    }

    private fun assertUnavailable(candidate: String?, action: () -> Unit) {
        val error = assertThrows(IOException::class.java) { action() }
        assertEquals(SupabasePublicAuthConfigurationResolver.UNAVAILABLE_MESSAGE, error.message)
        candidate?.takeIf { it.isNotEmpty() }?.let {
            assertFalse(error.message.orEmpty().contains(it))
        }
    }
}
