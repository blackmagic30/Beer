import java.io.File
import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

val releaseSigningVariableNames = listOf(
    "PINT_PATH_ANDROID_KEYSTORE_PATH",
    "PINT_PATH_ANDROID_KEYSTORE_PASSWORD",
    "PINT_PATH_ANDROID_KEY_ALIAS",
    "PINT_PATH_ANDROID_KEY_PASSWORD",
)
val releaseSigningEnvironment = releaseSigningVariableNames.associateWith { System.getenv(it) }
val configuredReleaseSigningVariables = releaseSigningVariableNames.filter {
    !releaseSigningEnvironment[it].isNullOrEmpty()
}

if (configuredReleaseSigningVariables.isNotEmpty()
    && configuredReleaseSigningVariables.size != releaseSigningVariableNames.size
) {
    val missingVariables = releaseSigningVariableNames - configuredReleaseSigningVariables.toSet()
    throw GradleException(
        "Android release signing is only partially configured. Set all four environment variables; missing: " +
            missingVariables.joinToString(", "),
    )
}

val releaseSigningConfigured = configuredReleaseSigningVariables.size == releaseSigningVariableNames.size
val androidAppProjectPath = project.path
val repositoryRoot = generateSequence(rootProject.projectDir.canonicalFile) { it.parentFile }
    .firstOrNull { file(it).resolve(".git").exists() }
val localConfiguration = Properties().apply {
    val localConfigurationFile = rootProject.file("local.properties")
    if (localConfigurationFile.isFile) {
        localConfigurationFile.inputStream().use { load(it) }
    }
}

fun configuredAndroidProperty(name: String): String? =
    providers.gradleProperty(name).orNull ?: localConfiguration.getProperty(name)

val approvedProductionApiBaseUrl = "https://pintpath.au"
val configuredApiBaseUrl = configuredAndroidProperty("PINT_PATH_API_BASE_URL")
    ?: approvedProductionApiBaseUrl
val embeddedReleaseApiBaseUrl = configuredApiBaseUrl
    .takeIf { it == approvedProductionApiBaseUrl }
    ?: ""

val approvedSupabaseOrigin = "https://auth.pintpath.au"
val configuredSupabaseOrigin = configuredAndroidProperty("SUPABASE_URL") ?: ""
if (configuredSupabaseOrigin.isNotEmpty() && configuredSupabaseOrigin != approvedSupabaseOrigin) {
    throw GradleException(
        "SUPABASE_URL must be the exact approved HTTPS authentication origin; " +
            "the configured value is hidden.",
    )
}
val embeddedSupabaseOrigin = configuredSupabaseOrigin
    .takeIf { it == approvedSupabaseOrigin }
    ?: ""

val supabasePublishableKeyPattern = Regex("^sb_publishable_[A-Za-z0-9_-]{20,220}$")
val configuredSupabasePublishableKey = configuredAndroidProperty("SUPABASE_ANON_KEY") ?: ""
if (configuredSupabasePublishableKey.isNotEmpty()
    && !supabasePublishableKeyPattern.matches(configuredSupabasePublishableKey)
) {
    throw GradleException(
        "SUPABASE_ANON_KEY must be an exact sb_publishable_ key with 20 to 220 URL-safe " +
            "characters. Legacy JWTs and secret keys are not accepted; the configured value is hidden.",
    )
}
val embeddedSupabasePublishableKey = configuredSupabasePublishableKey
    .takeIf { supabasePublishableKeyPattern.matches(it) }
    ?: ""

android {
    namespace = "au.pintpath.beermap"
    compileSdk = 37

    fun String.toBuildConfigString(): String =
        "\"" + replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    defaultConfig {
        applicationId = "au.pintpath.beermap"
        minSdk = 26
        targetSdk = 36
        versionCode = 2
        versionName = "1.0.0"

        buildConfigField("String", "PINT_PATH_API_BASE_URL", configuredApiBaseUrl.toBuildConfigString())
        buildConfigField("String", "SUPABASE_URL", embeddedSupabaseOrigin.toBuildConfigString())
        buildConfigField(
            "String",
            "SUPABASE_ANON_KEY",
            embeddedSupabasePublishableKey.toBuildConfigString(),
        )
    }

    signingConfigs {
        if (releaseSigningConfigured) {
            create("release") {
                val configuredStorePath = releaseSigningEnvironment.getValue(
                    "PINT_PATH_ANDROID_KEYSTORE_PATH",
                )!!
                val unresolvedStoreFile = File(configuredStorePath)
                if (!unresolvedStoreFile.isAbsolute) {
                    throw GradleException(
                        "PINT_PATH_ANDROID_KEYSTORE_PATH must be an absolute path.",
                    )
                }
                val configuredStoreFile = unresolvedStoreFile.canonicalFile
                if (repositoryRoot != null
                    && configuredStoreFile.toPath().startsWith(repositoryRoot.toPath())
                ) {
                    throw GradleException(
                        "PINT_PATH_ANDROID_KEYSTORE_PATH must point outside the repository checkout.",
                    )
                }
                if (!configuredStoreFile.isFile) {
                    throw GradleException(
                        "PINT_PATH_ANDROID_KEYSTORE_PATH must point to an existing keystore file.",
                    )
                }
                storeFile = configuredStoreFile
                storePassword = releaseSigningEnvironment.getValue("PINT_PATH_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = releaseSigningEnvironment.getValue("PINT_PATH_ANDROID_KEY_ALIAS")
                keyPassword = releaseSigningEnvironment.getValue("PINT_PATH_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        getByName("release") {
            buildConfigField(
                "String",
                "PINT_PATH_API_BASE_URL",
                embeddedReleaseApiBaseUrl.toBuildConfigString(),
            )
            if (releaseSigningConfigured) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

gradle.taskGraph.whenReady {
    val releaseBundleRequested = allTasks.any {
        it.project.path == androidAppProjectPath && it.name == "bundleRelease"
    }
    if (releaseBundleRequested && configuredApiBaseUrl != approvedProductionApiBaseUrl) {
        throw GradleException(
            "bundleRelease requires PINT_PATH_API_BASE_URL to be the exact approved HTTPS " +
                "production origin; the configured value is hidden.",
        )
    }
    if (releaseBundleRequested && configuredSupabaseOrigin != approvedSupabaseOrigin) {
        throw GradleException(
            "bundleRelease requires SUPABASE_URL to be the exact approved HTTPS " +
                "authentication origin; the configured value is hidden.",
        )
    }
    if (releaseBundleRequested && !supabasePublishableKeyPattern.matches(configuredSupabasePublishableKey)) {
        throw GradleException(
            "bundleRelease requires a nonblank SUPABASE_ANON_KEY containing an exact " +
                "sb_publishable_ key; the configured value is hidden.",
        )
    }
    if (releaseBundleRequested && !releaseSigningConfigured) {
        throw GradleException(
            "bundleRelease requires PINT_PATH_ANDROID_KEYSTORE_PATH, " +
                "PINT_PATH_ANDROID_KEYSTORE_PASSWORD, PINT_PATH_ANDROID_KEY_ALIAS, and " +
                "PINT_PATH_ANDROID_KEY_PASSWORD. Keep the keystore and values outside the repository.",
        )
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.08.00"))
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.core:core-ktx:1.19.0")
    implementation("androidx.exifinterface:exifinterface:1.4.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")

    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
}
