package com.hosani69.c64coder

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

/**
 * Hosts the C64 Coder web app (assets/www) in a WebView.
 *
 * The page is served from https://appassets.androidplatform.net so it has a
 * secure origin (needed for fetch() of the bundled ROMs and the Claude API).
 * A small JavaScript bridge lets the page save exported files through the
 * Android "Save as" dialog, and the WebView file chooser is wired up for imports.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingSave: ByteArray? = null
    private var pendingSaveName: String = ""

    // Game controller state, sent to the page as a C64 joystick bitmask
    // (1 up, 2 down, 4 left, 8 right, 16 fire).
    private var padButtons = 0
    private var padAxes = 0
    private var padStart = false
    private var padSelect = false
    private var lastSent = -1

    private val openFile = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val cb = fileCallback
        fileCallback = null
        if (cb == null) return@registerForActivityResult
        val data = result.data
        val uris: Array<Uri>? = if (result.resultCode == Activity.RESULT_OK && data != null) {
            val clip = data.clipData
            when {
                clip != null -> Array(clip.itemCount) { clip.getItemAt(it).uri }
                data.data != null -> arrayOf(data.data!!)
                else -> null
            }
        } else null
        cb.onReceiveValue(uris)
    }

    private val createDocument = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val bytes = pendingSave
        pendingSave = null
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null || bytes == null) {
            notifySave(false, "cancelled")
            return@registerForActivityResult
        }
        try {
            contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                ?: throw IllegalStateException("cannot open file")
            notifySave(true, pendingSaveName)
        } catch (e: Exception) {
            notifySave(false, e.message ?: "write failed")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        setContentView(webView)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = true
            textZoom = 100
        }
        webView.overScrollMode = View.OVER_SCROLL_NEVER
        webView.addJavascriptInterface(Bridge(), "AndroidBridge")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.host == "appassets.androidplatform.net") return false
                // Open external links (e.g. console.anthropic.com) in the browser.
                startActivity(Intent(Intent.ACTION_VIEW, url))
                return true
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                }
                return try {
                    openFile.launch(intent)
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript("(window.onBackPressed && window.onBackPressed()) ? 'yes' : 'no'") { handled ->
                    if (!handled.contains("yes")) {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            }
        })

        if (savedInstanceState != null) webView.restoreState(savedInstanceState)
        else webView.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")
    }

    private fun isController(event: android.view.InputEvent): Boolean {
        val src = event.source
        return (src and InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD ||
            (src and InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val code = event.keyCode
        val isPadKey = KeyEvent.isGamepadButton(code) ||
            (isController(event) && code in intArrayOf(
                KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN,
                KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_CENTER
            ))
        if (!isPadKey) return super.dispatchKeyEvent(event)
        val down = event.action == KeyEvent.ACTION_DOWN
        if (event.action != KeyEvent.ACTION_DOWN && event.action != KeyEvent.ACTION_UP) return true
        when (code) {
            KeyEvent.KEYCODE_BUTTON_START -> padStart = down
            KeyEvent.KEYCODE_BUTTON_SELECT, KeyEvent.KEYCODE_BUTTON_MODE -> padSelect = down
            else -> {
                val bit = when (code) {
                    KeyEvent.KEYCODE_DPAD_UP -> 1
                    KeyEvent.KEYCODE_DPAD_DOWN -> 2
                    KeyEvent.KEYCODE_DPAD_LEFT -> 4
                    KeyEvent.KEYCODE_DPAD_RIGHT -> 8
                    else -> 16          // A, B, X, Y, shoulders, triggers, stick clicks, d-pad center
                }
                padButtons = if (down) padButtons or bit else padButtons and bit.inv()
            }
        }
        sendPad()
        return true
    }

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
        if (!isController(event) || event.action != MotionEvent.ACTION_MOVE) {
            return super.dispatchGenericMotionEvent(event)
        }
        val x = event.getAxisValue(MotionEvent.AXIS_X)
        val y = event.getAxisValue(MotionEvent.AXIS_Y)
        val hx = event.getAxisValue(MotionEvent.AXIS_HAT_X)
        val hy = event.getAxisValue(MotionEvent.AXIS_HAT_Y)
        val trig = maxOf(
            event.getAxisValue(MotionEvent.AXIS_LTRIGGER), event.getAxisValue(MotionEvent.AXIS_RTRIGGER),
            event.getAxisValue(MotionEvent.AXIS_GAS), event.getAxisValue(MotionEvent.AXIS_BRAKE)
        )
        var bits = 0
        if (y < -0.5f || hy < -0.5f) bits = bits or 1
        if (y > 0.5f || hy > 0.5f) bits = bits or 2
        if (x < -0.5f || hx < -0.5f) bits = bits or 4
        if (x > 0.5f || hx > 0.5f) bits = bits or 8
        if (trig > 0.5f) bits = bits or 16
        padAxes = bits
        sendPad()
        return true
    }

    private fun sendPad() {
        val bits = padButtons or padAxes
        val state = bits or (if (padStart) 32 else 0) or (if (padSelect) 64 else 0)
        if (state == lastSent) return
        lastSent = state
        webView.evaluateJavascript(
            "window.nativeGamepad && window.nativeGamepad($bits, ${if (padStart) 1 else 0}, ${if (padSelect) 1 else 0})",
            null
        )
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    private fun notifySave(ok: Boolean, message: String) {
        runOnUiThread {
            webView.evaluateJavascript(
                "window.onNativeSaveResult && window.onNativeSaveResult($ok, ${JSONObject.quote(message)})",
                null
            )
        }
    }

    inner class Bridge {
        /** Called from JavaScript: ask the user where to save [name], then write the bytes. */
        @JavascriptInterface
        fun saveFile(name: String, mime: String, base64: String) {
            val bytes = try {
                Base64.decode(base64, Base64.DEFAULT)
            } catch (e: IllegalArgumentException) {
                notifySave(false, "bad data")
                return
            }
            runOnUiThread {
                pendingSave = bytes
                pendingSaveName = name
                val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = mime.ifBlank { "application/octet-stream" }
                    putExtra(Intent.EXTRA_TITLE, name)
                }
                try {
                    createDocument.launch(intent)
                } catch (e: Exception) {
                    pendingSave = null
                    notifySave(false, e.message ?: "no file app")
                }
            }
        }
    }
}
