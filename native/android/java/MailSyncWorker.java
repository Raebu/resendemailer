package global.gibp.mail;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

public class MailSyncWorker extends Worker {
  private static final String CHANNEL = "gibp_mail_incoming";
  private final Context context;
  private final SharedPreferences prefs;

  public MailSyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
    super(context, params);
    this.context = context;
    this.prefs = context.getSharedPreferences(BackgroundMailboxPlugin.PREFS, Context.MODE_PRIVATE);
  }

  @NonNull
  @Override
  public Result doWork() {
    try {
      boolean transientFailure = false;
      for (String key : prefs.getAll().keySet()) {
        if (!key.startsWith(BackgroundMailboxPlugin.ACCOUNT_PREFIX)) continue;
        String encrypted = prefs.getString(key, null);
        if (encrypted == null) continue;
        try {
          JSONObject account = new JSONObject(CryptoBox.decrypt(encrypted));
          pollAccount(account);
        } catch (java.io.IOException e) {
          transientFailure = true;
        } catch (Exception ignored) {
          // A broken individual account must not block the other accounts.
        }
      }
      return transientFailure ? Result.retry() : Result.success();
    } catch (Exception e) {
      return Result.retry();
    }
  }

  private void pollAccount(JSONObject account) throws Exception {
    String id = account.getString("id");
    String name = account.optString("name", "GIBP Mail");
    String apiKey = account.getString("apiKey");
    JSONObject response = getJson("https://api.resend.com/emails/receiving?limit=100", apiKey);
    JSONArray items = response.optJSONArray("data");
    if (items == null) {
      JSONObject nested = response.optJSONObject("data");
      if (nested != null) items = nested.optJSONArray("data");
    }
    if (items == null || items.length() == 0) return;

    String latestId = items.optJSONObject(0) != null ? items.optJSONObject(0).optString("id", "") : "";
    if (latestId.isEmpty()) return;
    String last = prefs.getString("last_" + id, null);

    // First background run establishes a cursor without flooding the user with historic notifications.
    if (last == null) {
      prefs.edit().putString("last_" + id, latestId).apply();
      return;
    }
    if (latestId.equals(last)) return;

    List<JSONObject> fresh = new ArrayList<>();
    for (int i = 0; i < items.length(); i++) {
      JSONObject item = items.optJSONObject(i);
      if (item == null) continue;
      String messageId = item.optString("id", "");
      if (messageId.equals(last)) break;
      fresh.add(item);
    }

    // Notify oldest-to-newest so the latest message remains visually last.
    for (int i = fresh.size() - 1; i >= 0; i--) notifyIncoming(name, fresh.get(i));
    prefs.edit().putString("last_" + id, latestId).apply();
  }

  private JSONObject getJson(String url, String apiKey) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
    connection.setRequestMethod("GET");
    connection.setConnectTimeout(15000);
    connection.setReadTimeout(25000);
    connection.setRequestProperty("Authorization", "Bearer " + apiKey);
    connection.setRequestProperty("Accept", "application/json");
    int status = connection.getResponseCode();
    if (status == 429 || status >= 500) throw new java.io.IOException("Transient Resend HTTP " + status);
    if (status < 200 || status >= 300) throw new IllegalStateException("Resend HTTP " + status);
    BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream()));
    StringBuilder body = new StringBuilder();
    String line;
    while ((line = reader.readLine()) != null) body.append(line);
    reader.close();
    connection.disconnect();
    return new JSONObject(body.toString());
  }

  private void notifyIncoming(String accountName, JSONObject item) {
    if (Build.VERSION.SDK_INT >= 33 &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      return;
    }
    NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    if (Build.VERSION.SDK_INT >= 26) {
      NotificationChannel channel = new NotificationChannel(CHANNEL, "Incoming mail", NotificationManager.IMPORTANCE_DEFAULT);
      channel.setDescription("New GIBP Mail messages");
      manager.createNotificationChannel(channel);
    }

    String from = item.optString("from", accountName);
    String subject = item.optString("subject", "New email");
    Intent intent = new Intent(context, MainActivity.class);
    intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    PendingIntent pending = PendingIntent.getActivity(
      context,
      Math.abs(item.optString("id", subject).hashCode()),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
    );

    NotificationCompat.Builder notification = new NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(context.getApplicationInfo().icon)
      .setContentTitle(from)
      .setContentText(subject)
      .setStyle(new NotificationCompat.BigTextStyle().bigText(subject))
      .setAutoCancel(true)
      .setContentIntent(pending)
      .setCategory(NotificationCompat.CATEGORY_EMAIL)
      .setPriority(NotificationCompat.PRIORITY_DEFAULT);

    manager.notify(Math.abs((item.optString("id", subject) + accountName).hashCode()), notification.build());
  }
}
