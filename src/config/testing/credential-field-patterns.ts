/**
 * Credential Field Patterns Configuration
 * Fallback dictionary for field classification (Level 3)
 * Used when semantic attributes (Level 1) and accessibility hints (Level 2) are not present
 *
 * NOTE: This is the LAST resort - prefer type/autocomplete/inputmode attributes (Level 1)
 */

export type CredentialKind = 'password' | 'email' | 'phone' | 'username';

/**
 * Fallback keyword patterns for each credential type
 * Keys are lowercase, matching is case-insensitive
 * Multilingual support: EN, RU, TR, KZ, UK, DE, FR, ES, PT, IT, PL, ZH, JA, AR
 */
export const CREDENTIAL_FALLBACK_PATTERNS: Record<CredentialKind, string[]> = {
  password: [
    // English
    // NOTE: 'passcode' is intentionally NOT here — as a single token it must not
    // classify as password (a passcode field is often a PIN/OTP-style entry, and
    // the classifier contract treats it as a non-match; see field-classifier tests).
    'password', 'passwd', 'pass', 'pwd', 'secret', 'pin',
    // Russian
    'пароль', 'парол', 'секрет', 'код',
    // Turkish
    'şifre', 'parola', 'gizli',
    // Kazakh
    'құпия', 'құпия сөз',
    // Ukrainian
    'пароль', 'секретний',
    // German
    'passwort', 'kennwort', 'geheimcode',
    // French
    'mot de passe', 'motdepasse', 'code',
    // Spanish
    'contraseña', 'clave', 'código',
    // Portuguese
    'senha', 'código',
    // Italian
    'password', 'parola', 'codice',
    // Polish
    'hasło', 'tajny',
    // Chinese
    '密码', '口令',
    // Japanese
    'パスワード', '暗証番号',
    // Arabic
    'كلمة المرور', 'كلمة السر', 'الرمز',
  ],
  email: [
    // English
    'email', 'e-mail', 'mail', 'address',
    // Russian
    'почта', 'емейл', 'эмейл', 'электронная почта',
    // Turkish
    'e-posta', 'eposta', 'mail',
    // Kazakh
    'электрондық пошта', 'пошта',
    // Ukrainian
    'електронна пошта', 'пошта',
    // German
    'e-mail', 'email', 'post',
    // French
    'e-mail', 'email', 'courriel',
    // Spanish
    'correo', 'email', 'correo electrónico',
    // Portuguese
    'e-mail', 'email', 'correio',
    // Italian
    'e-mail', 'email', 'posta',
    // Polish
    'e-mail', 'email', 'poczta',
    // Chinese
    '邮箱', '电子邮件', '邮件',
    // Japanese
    'メール', 'メールアドレス', 'Eメール',
    // Arabic
    'البريد الإلكتروني', 'البريد', 'إيميل',
  ],
  phone: [
    // English
    'phone', 'tel', 'mobile', 'cell', 'sms', 'number',
    // Russian
    'телефон', 'номер', 'мобильный', 'тел',
    // Turkish
    'telefon', 'tel', 'mobil', 'numara',
    // Kazakh
    'телефон', 'нөмір', 'ұялы',
    // Ukrainian
    'телефон', 'номер', 'мобільний',
    // German
    'telefon', 'handy', 'mobil', 'nummer',
    // French
    'téléphone', 'tél', 'mobile', 'portable',
    // Spanish
    'teléfono', 'tel', 'móvil', 'celular',
    // Portuguese
    'telefone', 'tel', 'celular', 'móvel',
    // Italian
    'telefono', 'tel', 'cellulare', 'mobile',
    // Polish
    'telefon', 'tel', 'komórka', 'numer',
    // Chinese
    '电话', '手机', '号码',
    // Japanese
    '電話', '電話番号', '携帯',
    // Arabic
    'هاتف', 'جوال', 'رقم الهاتف',
  ],
  username: [
    // English
    'username', 'user', 'login', 'account', 'userid', 'user id', 'name',
    // Russian
    'логин', 'пользователь', 'аккаунт', 'учетная', 'имя пользователя',
    // Turkish
    'kullanıcı adı', 'kullanıcı', 'giriş', 'hesap',
    // Kazakh
    'пайдаланушы', 'кіру', 'есептік жазба',
    // Ukrainian
    'користувач', 'логін', 'обліковий запис', 'ім\'я',
    // German
    'benutzername', 'benutzer', 'anmelden', 'konto',
    // French
    'nom d\'utilisateur', 'utilisateur', 'connexion', 'compte',
    // Spanish
    'nombre de usuario', 'usuario', 'iniciar sesión', 'cuenta',
    // Portuguese
    'nome de usuário', 'usuário', 'login', 'conta',
    // Italian
    'nome utente', 'utente', 'accesso', 'account',
    // Polish
    'nazwa użytkownika', 'użytkownik', 'login', 'konto',
    // Chinese
    '用户名', '用户', '登录', '账号',
    // Japanese
    'ユーザー名', 'ユーザー', 'ログイン', 'アカウント',
    // Arabic
    'اسم المستخدم', 'المستخدم', 'تسجيل الدخول', 'الحساب',
  ],
};

/**
 * Level 1: Technical semantic signals (highest confidence)
 * Maps attribute values to credential kinds
 */
export const LEVEL1_TYPE_MAP: Record<string, CredentialKind> = {
  password: 'password',
  email: 'email',
  tel: 'phone',
};

export const LEVEL1_AUTOCOMPLETE_MAP: Record<string, CredentialKind> = {
  'current-password': 'password',
  'new-password': 'password',
  password: 'password',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  'tel-local': 'phone',
  username: 'username',
};

export const LEVEL1_INPUTMODE_MAP: Record<string, CredentialKind> = {
  tel: 'phone',
  email: 'email',
};
