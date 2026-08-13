package au.pintpath.beermap.data

import java.net.HttpURLConnection
import java.net.URL
import java.net.URLConnection
import java.net.URLStreamHandler
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Test

class BeerMapApiTransportTest {
    @Test
    fun `disables redirects before a connection is returned to a request path`() {
        lateinit var createdConnection: StubHttpURLConnection
        val url = URL(null, "https://transport.invalid/request", object : URLStreamHandler() {
            override fun openConnection(url: URL): URLConnection =
                StubHttpURLConnection(url).also {
                    it.instanceFollowRedirects = true
                    createdConnection = it
                }
        })

        val connection = openNonRedirectingHttpConnection(url)

        assertSame(createdConnection, connection)
        assertFalse(connection.instanceFollowRedirects)
    }

    private class StubHttpURLConnection(url: URL) : HttpURLConnection(url) {
        override fun connect() = Unit
        override fun disconnect() = Unit
        override fun usingProxy(): Boolean = false
    }
}
