package app.nbase.android

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ContentResolver
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.print.PrintAttributes
import android.print.PrintManager
import android.provider.OpenableColumns
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import org.json.JSONObject

class MainActivity : Activity() {
    private lateinit var origin: String
    private lateinit var root: View
    private lateinit var container: FrameLayout
    private lateinit var errorPanel: View
    private lateinit var errorMessage: TextView
    private lateinit var bridge: WebBridge
    private var webView: WebView? = null
    private var bridgeReady = false
    private var mainFrameFailed = false
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val popups = mutableListOf<WebView>()
    private var backCallback: OnBackInvokedCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val saved = ServerStore(this).origin
        if (saved == null) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        origin = saved
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        setContentView(R.layout.activity_main)
        root = findViewById(R.id.root)
        container = findViewById(R.id.web_container)
        errorPanel = findViewById(R.id.error_panel)
        errorMessage = findViewById(R.id.error_message)
        findViewById<Button>(R.id.error_retry).setOnClickListener { retry() }
        findViewById<Button>(R.id.error_change_server).setOnClickListener {
            startActivity(Intent(this, SetupActivity::class.java))
        }
        SystemBars.install(window, root)
        SystemBars.setBackground(window, getColor(R.color.nb_bg))
        bridge = WebBridge(this, origin)
        createWebView()
        webView?.loadUrl("$origin/")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val callback = OnBackInvokedCallback { handleBack() }
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback)
            backCallback = callback
        }
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
        webView?.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView?.onResume()
    }

    override fun onDestroy() {
        if (::bridge.isInitialized) {
            fileCallback?.onReceiveValue(null)
            fileCallback = null
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                backCallback?.let { onBackInvokedDispatcher.unregisterOnBackInvokedCallback(it) }
            }
            popups.toList().forEach(::closePopup)
            webView?.let { container.removeView(it); it.destroy() }
            webView = null
            bridge.close()
        }
        super.onDestroy()
    }

    // Reached only below API 33; on 33+ the OnBackInvokedCallback registered in onCreate handles back.
    @SuppressLint("GestureBackNavigation")
    @Deprecated("Called only below API 33; newer versions use OnBackInvokedCallback.")
    @Suppress("OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        handleBack()
    }

    @Deprecated("Platform Activity result API.")
    @Suppress("OVERRIDE_DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != FILE_REQUEST) {
            @Suppress("DEPRECATION")
            super.onActivityResult(requestCode, resultCode, data)
            return
        }
        val callback = fileCallback ?: return
        fileCallback = null
        callback.onReceiveValue(if (resultCode == RESULT_OK) pickedFiles(data) else null)
    }

    fun onPageBackground(argb: Int) {
        if (!isDestroyed) SystemBars.setBackground(window, argb)
    }

    /** WebView ignores window.print(), so the bridge forwards it to the system print dialog (which can save a PDF). */
    fun printPage(title: String) {
        val view = webView ?: return
        if (isDestroyed) return
        val job = title.trim().take(MAX_PRINT_JOB_NAME).ifEmpty { getString(R.string.app_name) }
        getSystemService(PrintManager::class.java)
            ?.print(job, view.createPrintDocumentAdapter(job), PrintAttributes.Builder().build())
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView() {
        val view = WebView(this)
        view.layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        view.setBackgroundColor(getColor(R.color.nb_bg))
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(true)
            setGeolocationEnabled(false)
            userAgentString = "$userAgentString NBaseAndroid/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(view, false)
        }
        view.webViewClient = PageClient()
        view.webChromeClient = ChromeClient()
        view.setDownloadListener { url, _, contentDisposition, mimeType, _ -> onDownload(url, contentDisposition, mimeType) }
        bridgeReady = bridge.attach(view)
        container.addView(view)
        webView = view
    }

    private fun retry() {
        errorPanel.visibility = View.GONE
        webView?.loadUrl("$origin/") ?: run {
            createWebView()
            webView?.loadUrl("$origin/")
        }
    }

    private fun showError(message: String) {
        mainFrameFailed = true
        errorMessage.text = if (message.isBlank()) origin else "$message\n$origin"
        errorPanel.visibility = View.VISIBLE
    }

    private fun handleBack() {
        val view = webView
        if (view == null || errorPanel.visibility == View.VISIBLE) {
            moveTaskToBack(true)
            return
        }
        view.evaluateJavascript(CLOSE_OVERLAY_SCRIPT) { attempted ->
            if (attempted != "true") {
                navigateBack(view)
                return@evaluateJavascript
            }
            // React applies the close on its next render, so check after it had a chance to commit.
            view.postDelayed({
                if (webView !== view) return@postDelayed
                view.evaluateJavascript(OVERLAY_CLOSED_SCRIPT) { closed -> if (closed != "true") navigateBack(view) }
            }, OVERLAY_CHECK_DELAY_MS)
        }
    }

    private fun navigateBack(view: WebView) {
        if (view.canGoBack()) {
            view.goBack()
        } else {
            // Keep the page alive like a browser tab instead of finishing, so in-flight saves can complete.
            moveTaskToBack(true)
        }
    }

    private fun route(uri: Uri, mainFrame: Boolean): Boolean = when (NavigationPolicy.decide(uri.toString(), origin, mainFrame)) {
        Navigation.IN_APP -> false
        Navigation.EXTERNAL -> {
            openExternal(uri)
            true
        }
        Navigation.BLOCK -> true
    }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.external_unavailable, Toast.LENGTH_SHORT).show()
        }
    }

    private fun onDownload(url: String, contentDisposition: String?, mimeType: String?) {
        if (ServerAddress.originOf(url) != origin) {
            if (NavigationPolicy.decide(url, origin, true) == Navigation.EXTERNAL) openExternal(Uri.parse(url))
            return
        }
        if (!bridgeReady) {
            Toast.makeText(this, R.string.download_unsupported, Toast.LENGTH_LONG).show()
            return
        }
        val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
        webView?.evaluateJavascript(
            "window.__nbaseSaveUrl && window.__nbaseSaveUrl(${JSONObject.quote(url)}, ${JSONObject.quote(name)})", null)
    }

    private fun closePopup(popup: WebView) {
        if (popups.remove(popup)) root.post { popup.destroy() }
    }

    /**
     * Some ROM pickers (reported on HyperOS) return items without a URI, or URIs this app was not granted
     * read access to; WebView then drops them without telling the page. Pass on only what can be read and
     * say why the rest is missing.
     */
    private fun pickedFiles(data: Intent?): Array<Uri>? {
        val returned = returnedUris(data)
        val readable = returned.filter(::canRead)
        when (PickedFiles.problem(returned.size, readable.size)) {
            PickProblem.NONE_RETURNED -> toastLong(getString(R.string.file_picker_empty))
            PickProblem.ALL_UNREADABLE -> toastLong(getString(R.string.file_picker_unreadable))
            PickProblem.SOME_UNREADABLE ->
                toastLong(getString(R.string.file_picker_partly_unreadable, returned.size - readable.size))
            null -> Unit
        }
        return readable.takeIf { it.isNotEmpty() }?.toTypedArray()
    }

    private fun returnedUris(data: Intent?): List<Uri> {
        val clip = data?.clipData
        val fromClip = if (clip == null) emptyList() else (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
        return fromClip.ifEmpty { listOfNotNull(data?.data) }
    }

    // A metadata query needs the same read grant as opening the file but does not download cloud documents.
    private fun canRead(uri: Uri): Boolean {
        if (uri.scheme != ContentResolver.SCHEME_CONTENT) return true
        return try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { true } ?: false
        } catch (_: SecurityException) {
            false
        } catch (_: IllegalArgumentException) {
            false
        }
    }

    private fun toastLong(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    private inner class PageClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            route(request.url, request.isForMainFrame)

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            mainFrameFailed = false
            bridge.abortDownloads()
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (!mainFrameFailed) errorPanel.visibility = View.GONE
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) showError(error.description?.toString().orEmpty())
        }

        @SuppressLint("WebViewClientOnReceivedSslError")
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel()
            if (ServerAddress.originOf(error.url) == origin) showError(getString(R.string.error_ssl))
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            container.removeView(view)
            if (webView === view) webView = null
            view.destroy()
            if (!isDestroyed) {
                createWebView()
                webView?.loadUrl("$origin/")
                Toast.makeText(this@MainActivity, R.string.error_renderer, Toast.LENGTH_LONG).show()
            }
            return true
        }
    }

    /** window.open and target=_blank get a throwaway WebView that only forwards its first URL. */
    private inner class PopupClient : WebViewClient() {
        private var handled = false

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            forward(view, request.url)
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            if (url != null && url != "about:blank") {
                view.stopLoading()
                forward(view, Uri.parse(url))
            }
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            handled = true
            closePopup(view)
            return true
        }

        private fun forward(view: WebView, uri: Uri) {
            if (handled) return
            handled = true
            closePopup(view)
            when (NavigationPolicy.decide(uri.toString(), origin, true)) {
                Navigation.IN_APP -> webView?.loadUrl(uri.toString())
                Navigation.EXTERNAL -> openExternal(uri)
                Navigation.BLOCK -> Unit
            }
        }
    }

    private inner class ChromeClient : WebChromeClient() {
        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = null
            if (params.mode == MODE_OPEN_FOLDER) {
                Toast.makeText(this@MainActivity, R.string.folder_picker_unsupported, Toast.LENGTH_LONG).show()
                callback.onReceiveValue(null)
                return true
            }
            val intent = params.createIntent().addCategory(Intent.CATEGORY_OPENABLE)
            if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            return try {
                @Suppress("DEPRECATION")
                startActivityForResult(intent, FILE_REQUEST)
                fileCallback = callback
                true
            } catch (_: ActivityNotFoundException) {
                Toast.makeText(this@MainActivity, R.string.file_picker_unavailable, Toast.LENGTH_SHORT).show()
                false
            }
        }

        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            val popup = WebView(this@MainActivity)
            popup.webViewClient = PopupClient()
            popups += popup
            (resultMsg.obj as WebView.WebViewTransport).webView = popup
            resultMsg.sendToTarget()
            return true
        }

        override fun onCloseWindow(window: WebView) {
            closePopup(window)
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            request.deny()
        }
    }

    private companion object {
        const val FILE_REQUEST = 1001
        const val MAX_PRINT_JOB_NAME = 120

        /**
         * `FileChooserParams.MODE_OPEN_FOLDER` is hidden from the SDK. Some WebView versions report it for
         * `webkitdirectory`; others (WebView 133) report MODE_OPEN_MULTIPLE, which nbase-bridge.js intercepts.
         */
        const val MODE_OPEN_FOLDER = 2

        const val OVERLAY_CHECK_DELAY_MS = 200L

        /**
         * Asks the topmost menu or dialog to close the way a desktop user would. A modal `<dialog>` gets the
         * `cancel` event the browser fires for Escape (synthetic key events never reach it); other overlays
         * get an Escape keydown, and the open mobile navigation drawer gets a click on its `.nb-scrim`
         * backdrop. Returns whether an overlay was found; [OVERLAY_CLOSED_SCRIPT] then checks
         * that it actually went away, so an overlay that ignores the request cannot trap the back gesture.
         */
        const val CLOSE_OVERLAY_SCRIPT = """(() => {
  const dialogs = document.querySelectorAll('dialog[open]');
  const dialog = dialogs.length ? dialogs[dialogs.length - 1] : null;
  const nested = Array.from((dialog || document).querySelectorAll(
    '[role="menu"], [role="listbox"], [role="dialog"]:not(dialog), [aria-modal="true"]:not(dialog)'
  )).filter(el => el.getClientRects().length > 0);
  const scrim = dialog ? null : document.querySelector('.nb-scrim');
  const overlay = nested.length ? nested[nested.length - 1] : dialog || (scrim && scrim.getClientRects().length > 0 ? scrim : null);
  window.__nbaseBackOverlay = overlay || undefined;
  if (!overlay) return false;
  if (overlay === scrim) {
    scrim.click();
  } else if (overlay === dialog) {
    if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
  } else {
    const active = document.activeElement;
    const target = active && active !== document.body && overlay.contains(active) ? active : overlay;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
  }
  return true;
})()"""

        const val OVERLAY_CLOSED_SCRIPT = """(() => {
  const el = window.__nbaseBackOverlay;
  window.__nbaseBackOverlay = undefined;
  return !!el && (!el.isConnected || el.getClientRects().length === 0 || (el instanceof HTMLDialogElement && !el.open));
})()"""
    }
}
