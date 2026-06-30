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

    static var hairline: Color {
        Color.primary.opacity(0.08)
    }

    static var softShadow: Color {
        Color.black.opacity(0.07)
    }

    static var primaryGradient: LinearGradient {
        LinearGradient(
            colors: [honey, amber, leaf],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    static var screenGradient: LinearGradient {
        LinearGradient(
            colors: [
                background,
                amber.opacity(0.08),
                sky.opacity(0.06)
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}

extension View {
    func beerMapCard(padding: CGFloat = 16) -> some View {
        self
            .padding(padding)
            .background(BeerMapTheme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(BeerMapTheme.hairline, lineWidth: 1)
            )
            .shadow(color: BeerMapTheme.softShadow, radius: 10, x: 0, y: 5)
    }

    func readableForm() -> some View {
        self
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.done)
    }

    func beerMapScreen() -> some View {
        self
            .background(BeerMapTheme.screenGradient.ignoresSafeArea())
            .scrollDismissesKeyboard(.interactively)
    }
}
