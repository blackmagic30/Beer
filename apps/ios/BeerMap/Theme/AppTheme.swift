import SwiftUI
import UIKit

enum BeerMapTheme {
    // Beer-gold remains a recognisable brand cue, while interactive controls use a
    // high-contrast navy/sky pair. The colours adapt rather than assuming a light screen.
    static let amber = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 1.00, green: 0.72, blue: 0.34, alpha: 1)
            : UIColor(red: 0.58, green: 0.27, blue: 0.02, alpha: 1)
    })
    static let honey = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.31, green: 0.22, blue: 0.08, alpha: 1)
            : UIColor(red: 1.00, green: 0.92, blue: 0.76, alpha: 1)
    })
    static let primaryAction = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.48, green: 0.78, blue: 1.00, alpha: 1)
            : UIColor(red: 0.05, green: 0.22, blue: 0.38, alpha: 1)
    })
    static let primaryActionForeground = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? .black : .white
    })
    static let ink = Color(uiColor: .label)
    // System green/red are designed for large controls and can miss text contrast on
    // light cards. These adaptive variants remain recognisable while meeting WCAG AA
    // for small text on the app's grouped backgrounds.
    static let leaf = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.37, green: 0.85, blue: 0.55, alpha: 1)
            : UIColor(red: 0.00, green: 0.38, blue: 0.16, alpha: 1)
    })
    static let danger = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 1.00, green: 0.55, blue: 0.50, alpha: 1)
            : UIColor(red: 0.68, green: 0.10, blue: 0.07, alpha: 1)
    })
    static let sky = Color(uiColor: .systemBlue)
    static let plum = Color(uiColor: .systemIndigo)

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

    static var separator: Color {
        Color(uiColor: .separator)
    }
}

extension View {
    func beerMapCard(padding: CGFloat = 16) -> some View {
        self
            .padding(padding)
            .background(BeerMapTheme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(BeerMapTheme.hairline, lineWidth: 1)
            )
    }

    func readableForm() -> some View {
        self
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.done)
    }

    func beerMapScreen() -> some View {
        self
            .background(BeerMapTheme.background.ignoresSafeArea())
            .scrollDismissesKeyboard(.interactively)
    }
}
