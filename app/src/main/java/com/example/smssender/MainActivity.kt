package com.example.smssender

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.telephony.SmsManager
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.example.smssender.databinding.ActivityMainBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.BufferedReader
import java.io.InputStreamReader

/**
 * Prosta aplikacja: wczytuje listę numerów telefonów z pliku .txt (jeden
 * numer na linię, pełny format z kodem kraju, np. +48123456789) i wysyła
 * do każdego z nich tę samą wiadomość SMS, jeden po drugim, z odstępem
 * czasowym (żeby uniknąć blokady antyspamowej systemu/operatora).
 *
 * Działa na urządzeniu z JEDNĄ kartą SIM — używa domyślnego SmsManagera.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    /** Numery wczytane z pliku (już zwalidowane). */
    private var phoneNumbers: List<String> = emptyList()

    /** Trwające zadanie wysyłki — pozwala je przerwać przyciskiem "Zatrzymaj". */
    private var sendingJob: Job? = null

    private val pickFileLauncher =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            uri?.let { loadNumbersFromFile(it) }
        }

    private val requestSmsPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                startSending()
            } else {
                Toast.makeText(this, getString(R.string.err_permission_denied), Toast.LENGTH_LONG).show()
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnPickFile.setOnClickListener {
            pickFileLauncher.launch(arrayOf("text/plain"))
        }

        binding.btnSend.setOnClickListener {
            onSendClicked()
        }

        binding.btnStop.setOnClickListener {
            stopSending(userRequested = true)
        }
    }

    // --- Wczytywanie pliku ---

    private fun loadNumbersFromFile(uri: Uri) {
        try {
            val lines = mutableListOf<String>()
            contentResolver.openInputStream(uri)?.use { stream ->
                BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).forEachLine { rawLine ->
                    val trimmed = rawLine.trim()
                    if (trimmed.isNotEmpty()) lines.add(trimmed)
                }
            }

            val valid = mutableListOf<String>()
            var invalidCount = 0
            for (line in lines) {
                val normalized = normalizePhoneNumber(line)
                if (normalized != null) {
                    valid.add(normalized)
                } else {
                    invalidCount++
                }
            }

            phoneNumbers = valid
            binding.tvNumbersLoaded.text = getString(R.string.numbers_loaded, valid.size)

            if (invalidCount > 0) {
                Toast.makeText(
                    this,
                    getString(R.string.err_invalid_numbers, invalidCount),
                    Toast.LENGTH_LONG
                ).show()
            }
        } catch (e: Exception) {
            Toast.makeText(this, getString(R.string.err_read_file, e.message ?: ""), Toast.LENGTH_LONG).show()
        }
    }

    /**
     * Prosta walidacja/normalizacja numeru: usuwa spacje i myślniki,
     * akceptuje format z "+" i kodem kraju (np. +48123456789) lub bez niego,
     * o ile zostaje 7-15 cyfr. Linie, które w ogóle nie przypominają numeru
     * telefonu (np. puste, same litery), są odrzucane.
     */
    private fun normalizePhoneNumber(raw: String): String? {
        val cleaned = raw.replace(Regex("[\\s\\-()]"), "")
        return if (Regex("^\\+?\\d{7,15}$").matches(cleaned)) cleaned else null
    }

    // --- Wysyłka ---

    private fun onSendClicked() {
        if (phoneNumbers.isEmpty()) {
            Toast.makeText(this, getString(R.string.err_no_numbers), Toast.LENGTH_SHORT).show()
            return
        }
        val message = binding.etMessage.text.toString()
        if (message.isBlank()) {
            Toast.makeText(this, getString(R.string.err_no_message), Toast.LENGTH_SHORT).show()
            return
        }

        val hasPermission = ContextCompat.checkSelfPermission(
            this, Manifest.permission.SEND_SMS
        ) == PackageManager.PERMISSION_GRANTED

        if (hasPermission) {
            startSending()
        } else {
            requestSmsPermissionLauncher.launch(Manifest.permission.SEND_SMS)
        }
    }

    private fun startSending() {
        val message = binding.etMessage.text.toString()
        val delayMs = binding.etDelayMs.text.toString().toLongOrNull()?.coerceAtLeast(200L) ?: 1500L
        val numbers = phoneNumbers

        setSendingUiState(sending = true)

        sendingJob = lifecycleScope.launch {
            var sent = 0
            var failed = 0

            for ((index, number) in numbers.withIndex()) {
                binding.tvStatus.text = getString(R.string.status_sending, index + 1, numbers.size)
                binding.progressBar.progress = ((index + 1) * 100) / numbers.size

                val ok = withContext(Dispatchers.IO) { sendSingleSms(number, message) }
                if (ok) sent++ else failed++

                if (index < numbers.lastIndex) {
                    delay(delayMs)
                }
            }

            binding.tvStatus.text = getString(R.string.status_done, sent, failed)
            setSendingUiState(sending = false)
        }
    }

    private fun stopSending(userRequested: Boolean) {
        sendingJob?.cancel()
        sendingJob = null
        if (userRequested) {
            binding.tvStatus.text = getString(
                R.string.status_stopped,
                (binding.progressBar.progress * phoneNumbers.size) / 100,
                phoneNumbers.size
            )
        }
        setSendingUiState(sending = false)
    }

    private fun setSendingUiState(sending: Boolean) {
        binding.btnSend.isEnabled = !sending
        binding.btnPickFile.isEnabled = !sending
        binding.btnStop.isEnabled = sending
        if (!sending) {
            // zostawiamy pasek na 100%, jeśli zakończono naturalnie; przy
            // starcie kolejnej wysyłki i tak zostanie wyzerowany od nowa
        } else {
            binding.progressBar.progress = 0
        }
    }

    /**
     * Wysyła jedną wiadomość SMS. Dla wiadomości dłuższych niż limit
     * jednej wiadomości (ok. 160 znaków dla zwykłego alfabetu) używa
     * sendMultipartTextMessage, żeby treść nie została po cichu ucięta.
     */
    private fun sendSingleSms(number: String, message: String): Boolean {
        return try {
            val smsManager: SmsManager = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                getSystemService(SmsManager::class.java)
            } else {
                @Suppress("DEPRECATION")
                SmsManager.getDefault()
            }

            val parts = smsManager.divideMessage(message)
            if (parts.size > 1) {
                smsManager.sendMultipartTextMessage(number, null, parts, null, null)
            } else {
                smsManager.sendTextMessage(number, null, message, null, null)
            }
            true
        } catch (e: Exception) {
            false
        }
    }
}
