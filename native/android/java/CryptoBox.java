package global.gibp.mail;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class CryptoBox {
  private static final String STORE = "AndroidKeyStore";
  private static final String ALIAS = "gibp_mail_background_v1";

  private static SecretKey key() throws Exception {
    KeyStore ks = KeyStore.getInstance(STORE);
    ks.load(null);
    java.security.Key existing = ks.getKey(ALIAS, null);
    if (existing instanceof SecretKey) return (SecretKey) existing;
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE);
    generator.init(new KeyGenParameterSpec.Builder(
      ALIAS,
      KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
    ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
     .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
     .setKeySize(256)
     .build());
    return generator.generateKey();
  }

  static String encrypt(String plain) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, key());
    byte[] iv = cipher.getIV();
    byte[] encrypted = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
    return Base64.encodeToString(iv, Base64.NO_WRAP) + "." + Base64.encodeToString(encrypted, Base64.NO_WRAP);
  }

  static String decrypt(String packed) throws Exception {
    String[] parts = packed.split("\\.", 2);
    if (parts.length != 2) throw new IllegalArgumentException("Invalid encrypted value");
    byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
    byte[] encrypted = Base64.decode(parts[1], Base64.NO_WRAP);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
    return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
  }

  private CryptoBox() {}
}
