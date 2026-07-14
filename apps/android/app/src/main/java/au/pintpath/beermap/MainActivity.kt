package au.pintpath.beermap

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.mutableStateOf
import au.pintpath.beermap.ui.features.BeerMapApp
import au.pintpath.beermap.ui.theme.BeerMapTheme

class MainActivity : ComponentActivity() {
    private val oauthCallback = mutableStateOf<Uri?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        oauthCallback.value = intent?.data
        enableEdgeToEdge()
        setContent {
            BeerMapTheme {
                BeerMapApp(
                    oauthCallback = oauthCallback.value,
                    onOAuthCallbackConsumed = { oauthCallback.value = null }
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        oauthCallback.value = intent.data
    }
}
