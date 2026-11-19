package app.nbase.android

import android.content.ContentValues
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.MimeTypeMap
import android.webkit.WebView
import android.widget.Toast
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import org.json.JSONException
import org.json.JSONObject

/**
 * Receives messages from assets/nbase-bridge.js. WebView cannot hand blob: downloads to the system, so the
 * page streams them here in base64 chunks and they are written to Downloads/NBase through MediaStore.
 */
class WebBridge(private val activity: MainActivity, private val origin: String) {
    private class Download(val uri: Uri, val stream: OutputStream, val expectedSize: Long) {
        var written = 0L
    }

    // Single thread: chunks of one download arrive in order and `downloads` needs no locking.
    private val io: ExecutorService = Executors.newSingleThreadExecutor()
    private val downloads = HashMap<String, Download>()
    private val script: String by lazy { activity.assets.open("nbase-bridge.js").bufferedReader().use { it.readText() } }

    /** Returns false when the installed WebView is too old for origin-restricted messaging. */
    fun attach(view: WebView): Boolean {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return false
        val rules = setOf(origin)
        WebViewCompat.addWebMessageListener(view, "NBaseAndroid", rules) { _, message, sourceOrigin, isMainFrame, _ ->
            val data = message.data
            if (isMainFrame && data != null && ServerAddress.originOf(sourceOrigin.toString()) == origin) {
                submit { handle(data) }
            }
        }
        WebViewCompat.addDocumentStartJavaScript(view, script, rules)
        return true
    }

    /** Drops downloads whose page went away; their pending MediaStore entries are deleted. */
    fun abortDownloads() = submit { abortAll() }

    fun close() {
        submit { abortAll() }
        io.shutdown()
    }

    private fun submit(task: () -> Unit) {
        try {
            io.execute(task)
        } catch (_: RejectedExecutionException) {
            // Already closed: the activity is gone and nothing is left to write.
        }
    }

    private fun handle(data: String) {
        val json = try {
            JSONObject(data)
        } catch (_: JSONException) {
            return
        }
        val id = json.optString("id")
        when (json.optString("type")) {
            "theme" -> {
                val color = CssColor.parse(json.optString("background")) ?: return
                activity.runOnUiThread { activity.onPageBackground(color) }
            }
            "print" -> activity.runOnUiThread { activity.printPage(json.optString("title")) }
            "folder-unsupported" -> toast(activity.getString(R.string.folder_picker_unsupported))
            "download-begin" -> begin(id, json.optString("name"), json.optLong("size", -1))
            "download-chunk" -> chunk(id, json.optString("data"))
            "download-end" -> end(id)
            "download-error" -> fail(id, json.optString("message").ifBlank { "页面未能读取文件" })
        }
    }

    private fun begin(id: String, rawName: String, size: Long) {
        if (id.isEmpty() || id.length > 64 || id in downloads || downloads.size >= MAX_PARALLEL) {
            toast(activity.getString(R.string.download_failed, "同时进行的下载过多"))
            return
        }
        val name = FileNames.sanitize(rawName)
        // MediaStore appends an extension when the MIME type disagrees with the name, so derive it from the name.
        val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(FileNames.extension(name))
            ?: "application/octet-stream"
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/NBase")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val resolver = activity.contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        if (uri == null) {
            toast(activity.getString(R.string.download_failed, "无法在“下载”中创建文件"))
            return
        }
        val stream = try {
            resolver.openOutputStream(uri)
        } catch (_: IOException) {
            null
        }
        if (stream == null) {
            resolver.delete(uri, null, null)
            toast(activity.getString(R.string.download_failed, "无法写入“下载”"))
            return
        }
        downloads[id] = Download(uri, stream, size)
    }

    private fun chunk(id: String, data: String) {
        val download = downloads[id] ?: return
        try {
            val bytes = Base64.decode(data, Base64.DEFAULT)
            download.stream.write(bytes)
            download.written += bytes.size
        } catch (e: Exception) {
            discard(id)
            toast(activity.getString(R.string.download_failed, e.message ?: "写入失败"))
        }
    }

    private fun end(id: String) {
        val download = downloads.remove(id) ?: return
        val resolver = activity.contentResolver
        try {
            download.stream.close()
            if (download.expectedSize >= 0 && download.written != download.expectedSize) throw IOException("文件不完整")
            resolver.update(download.uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            toast(activity.getString(R.string.download_saved, displayName(download.uri)))
        } catch (e: Exception) {
            resolver.delete(download.uri, null, null)
            toast(activity.getString(R.string.download_failed, e.message ?: "保存失败"))
        }
    }

    private fun fail(id: String, message: String) {
        discard(id)
        toast(activity.getString(R.string.download_failed, message))
    }

    private fun discard(id: String) {
        val download = downloads.remove(id) ?: return
        try {
            download.stream.close()
        } catch (_: IOException) {
        }
        activity.contentResolver.delete(download.uri, null, null)
    }

    private fun abortAll() {
        downloads.keys.toList().forEach(::discard)
    }

    private fun displayName(uri: Uri): String =
        activity.contentResolver.query(uri, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        } ?: ""

    private fun toast(message: String) {
        activity.runOnUiThread {
            if (!activity.isDestroyed) Toast.makeText(activity, message, Toast.LENGTH_LONG).show()
        }
    }

    private companion object {
        const val MAX_PARALLEL = 4
    }
}
