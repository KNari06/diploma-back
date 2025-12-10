/**
 * Generate test recommendations based on exploration
 */
export function generateTestRecommendations(
  visualAnalysis: any,
  domAnalysis: any,
  scope: string
): string[] {
  const recommendations: string[] = [];

  // Form-based recommendations
  if (domAnalysis.forms.length > 0) {
    recommendations.push('Test form validation (empty fields, invalid data)');
    recommendations.push('Test successful form submission');

    const requiredFields = domAnalysis.forms[0]?.fields.filter((f: any) => f.required);
    if (requiredFields && requiredFields.length > 0) {
      recommendations.push(`Test required fields: ${requiredFields.map((f: any) => f.name).join(', ')}`);
    }
  }

  // Button-based recommendations
  if (domAnalysis.buttons.length > 0) {
    const submitButtons = domAnalysis.buttons.filter((b: any) =>
      b.type === 'submit' || b.text.toLowerCase().includes('submit')
    );
    if (submitButtons.length > 0) {
      recommendations.push('Test button click and response');
    }
  }

  // Visual analysis recommendations
  if (visualAnalysis.suggestions) {
    recommendations.push(...visualAnalysis.suggestions.slice(0, 3));
  }

  // Scope-specific recommendations
  const scopeLower = scope.toLowerCase();

  if (scopeLower.includes('регистрац') || scopeLower.includes('register')) {
    recommendations.push('Test password strength validation');
    recommendations.push('Test email format validation');
    recommendations.push('Test redirect after successful registration');
  }

  if (scopeLower.includes('логин') || scopeLower.includes('login')) {
    recommendations.push('Test login with invalid credentials');
    recommendations.push('Test "Forgot password" link');
  }

  return recommendations.slice(0, 8); // Max 8 recommendations
}
