import SwiftUI

enum BeerMapTheme {
    static let amber = Color(red: 0.97, green: 0.52, blue: 0.16)
    static let honey = Color(red: 1.00, green: 0.77, blue: 0.30)
    static let ink = Color(red: 0.07, green: 0.09, blue: 0.12)
    static let leaf = Color(red: 0.16, green: 0.55, blue: 0.35)
    static let sky = Color(red: 0.18, green: 0.62, blue: 0.88)
    static let plum = Color(red: 0.42, green: 0.27, blue: 0.70)

    static var background: Color {
        Color(uiColor: .systemGroupedBackground)
    }

    static var card: Color {
        Color(uiColor: .secondarySystemGroupedBackground)
    }

    static var softCard: Color {
        Color(uiColor: .tertiarySystemGroupedBackground)
    }

    static var primaryGradient: LinearGradient {
        LinearGradient(
            colors: [honey, amber, sky],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}

extension View {
    func beerMapCard() -> some View {
        self
            .padding(16)
            .background(BeerMapTheme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(Color.primary.opacity(0.08), lineWidth: 1)
            )
    }

    func readableForm() -> some View {
        self
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.done)
    }
}

