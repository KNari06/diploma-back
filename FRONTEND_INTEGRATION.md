# 📱 Frontend Integration Guide

## API Changes Summary

### 1. POST /api/v1/workspaces/onboarding

**NEW REQUIRED FIELDS:**
```typescript
{
  // ... existing fields
  "role": "qaEngineer" | "developer" | "productManager" | "teamLead" | "cto" | "other",
  "position": "Senior QA Engineer",        // optional, max 255 chars
  "accountType": "company" | "individual",
  "companyName": "Acme Corp"              // required when accountType = "company"
}
```

**NEW RESPONSE:**
```typescript
{
  "success": true,
  "data": {
    "workspace_id": "uuid-here",  // ✨ NEW - use this for logo upload
    "name": "My Project",
    "baseUrls": ["https://dev.example.com"],
    "environments": { "dev": "https://dev.example.com" },
    "browserType": "chrome",
    "completed": true,
    // ✨ NEW FIELDS
    "role": "qaEngineer",
    "position": "Senior QA Engineer",
    "accountType": "company",
    "companyName": "Acme Corp",
    "logo_url": null  // or URL if logo exists
  }
}
```

**VALIDATION:**
- `role` - required, must be one of the enum values
- `accountType` - required
- `companyName` - **required** when `accountType = "company"`, max 255 chars
- `position` - optional, max 255 chars

---

### 2. POST /api/v1/workspaces/:id/logo

**Upload workspace logo**

```typescript
// Example using FormData
const formData = new FormData();
formData.append('logo', file); // File object from input

const response = await fetch(`/api/v1/workspaces/${workspaceId}/logo`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`
  },
  body: formData
});
```

**REQUEST:**
- Content-Type: `multipart/form-data`
- Field name: `logo`
- File types: PNG, JPG, JPEG, SVG, WebP
- Max size: 2MB

**RESPONSE:**
```json
{
  "success": true,
  "data": {
    "logo_url": "https://xxx.supabase.co/storage/v1/object/public/workspace-logos/...",
    "file_name": "logo_1707734400000.png",
    "file_size": 102400,
    "uploaded_at": "2024-02-12T10:30:00.000Z"
  },
  "message": "Logo uploaded successfully"
}
```

**ERROR RESPONSES:**
```json
// File too large (>2MB)
{ "success": false, "error": "File too large", "message": "Logo file must be smaller than 2MB" }

// Invalid file type
{ "success": false, "error": "Invalid file type", "message": "Only PNG, JPG, SVG, and WebP files are allowed" }

// No permission
{ "success": false, "error": "Access denied", "message": "You do not have permission to modify this workspace" }
```

---

### 3. DELETE /api/v1/workspaces/:id/logo

**Delete workspace logo**

```typescript
const response = await fetch(`/api/v1/workspaces/${workspaceId}/logo`, {
  method: 'DELETE',
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

**RESPONSE:**
```json
{
  "success": true,
  "message": "Logo deleted successfully"
}
```

---

## TypeScript Types (for Frontend)

```typescript
// Enums
type WorkspaceRole =
  | 'qaEngineer'
  | 'developer'
  | 'productManager'
  | 'teamLead'
  | 'cto'
  | 'other';

type WorkspaceAccountType = 'company' | 'individual';

// Onboarding Request
interface WorkspaceOnboardingRequest {
  name: string;
  baseUrls: string[];
  environments: {
    dev?: string;
    predprod?: string;
    prod?: string;
  };
  browserType: 'chrome' | 'firefox' | 'safari' | 'edge';
  // NEW
  role: WorkspaceRole;
  position?: string;
  accountType: WorkspaceAccountType;
  companyName?: string; // required when accountType === 'company'
}

// Onboarding Response
interface WorkspaceOnboardingResponse {
  workspace_id?: string; // NEW - returned when onboarding completed
  name?: string;
  baseUrls?: string[];
  environments?: {
    dev?: string;
    predprod?: string;
    prod?: string;
  };
  browserType?: 'chrome' | 'firefox' | 'safari' | 'edge';
  completed: boolean;
  // NEW
  role?: WorkspaceRole;
  position?: string;
  accountType?: WorkspaceAccountType;
  companyName?: string;
  logo_url?: string; // NEW - logo URL if uploaded
}

// Logo Upload Response
interface LogoUploadResponse {
  logo_url: string;
  file_name: string;
  file_size: number;
  uploaded_at: string;
}
```

---

## React Example

```tsx
import { useState } from 'react';

// 1. Onboarding Form
const OnboardingForm = () => {
  const [formData, setFormData] = useState({
    name: '',
    baseUrls: [''],
    environments: { dev: '' },
    browserType: 'chrome' as const,
    role: 'qaEngineer' as const,
    position: '',
    accountType: 'individual' as const,
    companyName: ''
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const response = await fetch('/api/v1/workspaces/onboarding', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(formData)
    });

    const data = await response.json();
    if (data.success) {
      const workspaceId = data.data.workspace_id; // ✨ Use this for logo upload
      console.log('Workspace created:', workspaceId);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      {/* ... existing fields ... */}

      {/* NEW: Role */}
      <select
        value={formData.role}
        onChange={e => setFormData({...formData, role: e.target.value})}
        required
      >
        <option value="qaEngineer">QA Engineer</option>
        <option value="developer">Developer</option>
        <option value="productManager">Product Manager</option>
        <option value="teamLead">Team Lead</option>
        <option value="cto">CTO</option>
        <option value="other">Other</option>
      </select>

      {/* NEW: Position (optional) */}
      <input
        type="text"
        placeholder="Position (optional)"
        value={formData.position}
        onChange={e => setFormData({...formData, position: e.target.value})}
        maxLength={255}
      />

      {/* NEW: Account Type */}
      <select
        value={formData.accountType}
        onChange={e => setFormData({...formData, accountType: e.target.value})}
        required
      >
        <option value="individual">Individual</option>
        <option value="company">Company</option>
      </select>

      {/* NEW: Company Name (conditional) */}
      {formData.accountType === 'company' && (
        <input
          type="text"
          placeholder="Company Name *"
          value={formData.companyName}
          onChange={e => setFormData({...formData, companyName: e.target.value})}
          required
          maxLength={255}
        />
      )}

      <button type="submit">Complete Onboarding</button>
    </form>
  );
};

// 2. Logo Upload Component
const LogoUpload = ({ workspaceId }: { workspaceId: string }) => {
  const [uploading, setUploading] = useState(false);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Client-side validation
    const maxSize = 2 * 1024 * 1024; // 2MB
    const allowedTypes = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];

    if (file.size > maxSize) {
      alert('File too large. Maximum size is 2MB');
      return;
    }

    if (!allowedTypes.includes(file.type)) {
      alert('Invalid file type. Allowed: PNG, JPG, SVG, WebP');
      return;
    }

    setUploading(true);

    const formData = new FormData();
    formData.append('logo', file);

    try {
      const response = await fetch(`/api/v1/workspaces/${workspaceId}/logo`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: formData
      });

      const data = await response.json();

      if (data.success) {
        setLogoUrl(data.data.logo_url);
        alert('Logo uploaded successfully!');
      } else {
        alert(data.message || 'Upload failed');
      }
    } catch (error) {
      alert('Upload error');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Delete logo?')) return;

    try {
      const response = await fetch(`/api/v1/workspaces/${workspaceId}/logo`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      const data = await response.json();

      if (data.success) {
        setLogoUrl(null);
        alert('Logo deleted!');
      }
    } catch (error) {
      alert('Delete error');
    }
  };

  return (
    <div>
      {logoUrl && (
        <div>
          <img src={logoUrl} alt="Workspace logo" style={{ maxWidth: 200 }} />
          <button onClick={handleDelete}>Delete Logo</button>
        </div>
      )}

      <input
        type="file"
        accept=".png,.jpg,.jpeg,.svg,.webp"
        onChange={handleFileChange}
        disabled={uploading}
      />

      {uploading && <p>Uploading...</p>}
    </div>
  );
};
```

---

## Key Points for Frontend

1. **`workspace_id` is now returned** in onboarding response - use it for logo upload
2. **Conditional validation**: `companyName` required when `accountType = 'company'`
3. **File upload**: use `FormData` with field name `logo`
4. **Client-side validation recommended**: check file size (2MB) and type before upload
5. **Logo URL**: returned in onboarding response and can be displayed immediately
6. **Error handling**: check `success` field in response, show error messages to user

---

## Testing

```bash
# 1. Test onboarding with new fields
curl -X POST http://localhost:3000/api/v1/workspaces/onboarding \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Project",
    "baseUrls": ["https://example.com"],
    "environments": { "dev": "https://dev.example.com" },
    "browserType": "chrome",
    "role": "qaEngineer",
    "position": "Senior QA",
    "accountType": "company",
    "companyName": "Acme Corp"
  }'

# 2. Upload logo
curl -X POST http://localhost:3000/api/v1/workspaces/WORKSPACE_ID/logo \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "logo=@/path/to/logo.png"

# 3. Delete logo
curl -X DELETE http://localhost:3000/api/v1/workspaces/WORKSPACE_ID/logo \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Migration Required

⚠️ **Backend migration must be applied before frontend deployment:**

1. Run migration: `supabase-migrations/20260212_workspace_onboarding_logo.sql`
2. Create storage bucket: `workspace-logos` (via Supabase Dashboard)
3. Add RLS policies (documented in migration)

See `IMPLEMENTATION_SUMMARY.md` for detailed backend setup.
