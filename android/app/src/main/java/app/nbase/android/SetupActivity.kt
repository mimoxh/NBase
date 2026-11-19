package app.nbase.android

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class SetupActivity : Activity() {
    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    private lateinit var input: EditText
    private lateinit var preview: TextView
    private lateinit var status: TextView
    private lateinit var connect: Button
    private var probing = false
    private var backCallback: OnBackInvokedCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)
        val root = findViewById<View>(R.id.root)
        SystemBars.install(window, root)
        SystemBars.setBackground(window, getColor(R.color.nb_bg))
        input = findViewById(R.id.server_input)
        preview = findViewById(R.id.origin_preview)
        status = findViewById(R.id.status)
        connect = findViewById(R.id.connect)

        if (savedInstanceState == null) input.setText(ServerStore(this).origin.orEmpty())
        input.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) = updatePreview()
        })
        input.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_GO) {
                submit()
                true
            } else {
                false
            }
        }
        connect.setOnClickListener { submit() }
        updatePreview()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val callback = OnBackInvokedCallback { leave() }
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback)
            backCallback = callback
        }
    }

    override fun onDestroy() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            backCallback?.let { onBackInvokedDispatcher.unregisterOnBackInvokedCallback(it) }
        }
        executor.shutdownNow()
        super.onDestroy()
    }

    // Reached only below API 33; on 33+ the OnBackInvokedCallback registered in onCreate handles back.
    @SuppressLint("GestureBackNavigation")
    @Deprecated("Called only below API 33; newer versions use OnBackInvokedCallback.")
    @Suppress("OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        leave()
    }

    /** The launcher shortcut starts this screen in a cleared task, so back must reopen the saved server itself. */
    private fun leave() {
        if (isTaskRoot && ServerStore(this).origin != null) startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    private fun updatePreview() {
        status.text = ""
        preview.text = when (val result = ServerAddress.parse(input.text.toString())) {
            is ServerAddressResult.Valid -> getString(R.string.setup_origin_preview, result.origin)
            is ServerAddressResult.Invalid -> if (input.text.isBlank()) "" else result.message
        }
    }

    private fun submit() {
        if (probing) return
        val result = ServerAddress.parse(input.text.toString())
        if (result is ServerAddressResult.Invalid) {
            preview.text = ""
            showStatus(result.message, error = true)
            return
        }
        val origin = (result as ServerAddressResult.Valid).origin
        probing = true
        connect.isEnabled = false
        showStatus(getString(R.string.setup_connecting), error = false)
        executor.execute {
            val failure = HealthProbe.check(origin)
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                probing = false
                connect.isEnabled = true
                if (failure != null) {
                    showStatus(failure, error = true)
                    return@runOnUiThread
                }
                ServerStore(this).origin = origin
                startActivity(Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
                finish()
            }
        }
    }

    private fun showStatus(message: String, error: Boolean) {
        status.setTextColor(getColor(if (error) R.color.nb_danger else R.color.nb_muted))
        status.text = message
    }
}
