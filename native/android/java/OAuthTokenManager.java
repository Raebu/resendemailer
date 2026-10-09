package global.gibp.mail;

import android.content.Context;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

final class OAuthTokenManager {
  private OAuthTokenManager() {}

  static synchronized String bearer(Context context, JSONObject account) throws Exception {
    String authMode = account.optString("authMode", "api_key");
    if (!"oauth".equals(authMode)) {
      String apiKey = account.optString("apiKey", "");
      if (!apiKey.startsWith("re_")) throw new IllegalStateException("Resend API key is unavailable");
      return apiKey;
    }

    String accessToken = account.optString("accessToken", "");
    long expiresAt = account.optLong("tokenExpiresAt", 0L);
    if (!accessToken.isEmpty() && expiresAt > System.currentTimeMillis() + 60_000L) return accessToken;

    String refreshToken = account.optString("refreshToken", "");
    String clientId = account.optString("clientId", "");
    if (refreshToken.isEmpty() || clientId.isEmpty()) throw new IllegalStateException("Resend OAuth authorization is incomplete");

    JSONObject response = postForm(
      "https://api.resend.com/oauth/token",
      "grant_type=refresh_token&client_id=" + enc(clientId) + "&refresh_token=" + enc(refreshToken)
    );

    String nextAccess = response.optString("access_token", "");
    String nextRefresh = response.optString("refresh_token", "");
    if (nextAccess.isEmpty() || nextRefresh.isEmpty()) throw new IllegalStateException("Resend OAuth refresh returned no tokens");

    long expiresIn = Math.max(60L, response.optLong("expires_in", 900L));
    account.put("accessToken", nextAccess);
    account.put("refreshToken", nextRefresh);
    account.put("tokenExpiresAt", System.currentTimeMillis() + expiresIn * 1000L);
    if (response.has("scope")) account.put("scope", response.optString("scope", account.optString("scope", "full_access")));

    String id = account.optString("id", "");
    if (!id.isEmpty()) {
      BackgroundMailboxPlugin.putEncrypted(context, BackgroundMailboxPlugin.ACCOUNT_PREFIX + id, account.toString());
    }
    return nextAccess;
  }

  static synchronized void revoke(Context context, JSONObject account) throws Exception {
    if (account == null) return;
    if ("oauth".equals(account.optString("authMode", "api_key"))) {
      String clientId = account.optString("clientId", "");
      String refreshToken = account.optString("refreshToken", "");
      if (!clientId.isEmpty() && !refreshToken.isEmpty()) {
        postForm(
          "https://api.resend.com/oauth/revoke",
          "client_id=" + enc(clientId) + "&token=" + enc(refreshToken) + "&token_type_hint=refresh_token"
        );
      }
    }
  }

  private static String enc(String value) throws Exception {
    return URLEncoder.encode(value, StandardCharsets.UTF_8.toString());
  }

  private static JSONObject postForm(String url, String body) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
    connection.setRequestMethod("POST");
    connection.setConnectTimeout(15_000);
    connection.setReadTimeout(30_000);
    connection.setDoOutput(true);
    connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
    connection.setRequestProperty("Accept", "application/json");

    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
    try (OutputStream out = connection.getOutputStream()) {
      out.write(bytes);
    }

    int status = connection.getResponseCode();
    BufferedReader reader = new BufferedReader(new InputStreamReader(
      status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream()
    ));
    StringBuilder text = new StringBuilder();
    String line;
    while ((line = reader.readLine()) != null) text.append(line);
    reader.close();
    connection.disconnect();

    JSONObject json = text.length() == 0 ? new JSONObject() : new JSONObject(text.toString());
    if (status == 429 || status >= 500) throw new java.io.IOException("Transient Resend OAuth HTTP " + status);
    if (status < 200 || status >= 300) {
      throw new IllegalStateException(json.optString("error_description", json.optString("error", "Resend OAuth HTTP " + status)));
    }
    return json;
  }
}
