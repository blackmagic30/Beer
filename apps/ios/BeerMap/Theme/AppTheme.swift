import SwiftUI
import UIKit

enum BeerMapTheme {
    // Pint Path's visual language borrows from Melbourne pub signs and transit maps:
    // warm paper, near-black ink and a single copper-orange route colour.
    static let brandInk = Color(red: 0.07, green: 0.09, blue: 0.08)
    static let paper = Color(red: 0.98, green: 0.96, blue: 0.91)
    static let brandGold = Color(red: 0.95, green: 0.52, blue: 0.16)
    static let markerUIColor = UIColor(red: 0.91, green: 0.39, blue: 0.08, alpha: 1)
    static let markerInkUIColor = UIColor(red: 0.08, green: 0.09, blue: 0.08, alpha: 1)

    static let amber = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 1.00, green: 0.69, blue: 0.31, alpha: 1)
            : UIColor(red: 0.57, green: 0.24, blue: 0.015, alpha: 1)
    })
    static let honey = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.28, green: 0.19, blue: 0.08, alpha: 1)
            : UIColor(red: 1.00, green: 0.88, blue: 0.67, alpha: 1)
    })
    static let primaryAction = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.96, green: 0.56, blue: 0.21, alpha: 1)
            : UIColor(red: 0.07, green: 0.09, blue: 0.08, alpha: 1)
    })
    static let primaryActionForeground = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.07, green: 0.09, blue: 0.08, alpha: 1)
            : UIColor(red: 0.98, green: 0.96, blue: 0.91, alpha: 1)
    })
    static let ink = Color(uiColor: .label)
    static let leaf = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.46, green: 0.86, blue: 0.58, alpha: 1)
            : UIColor(red: 0.00, green: 0.35, blue: 0.15, alpha: 1)
    })
    static let danger = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 1.00, green: 0.55, blue: 0.50, alpha: 1)
            : UIColor(red: 0.65, green: 0.08, blue: 0.06, alpha: 1)
    })
    static let sky = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.48, green: 0.76, blue: 0.92, alpha: 1)
            : UIColor(red: 0.04, green: 0.36, blue: 0.53, alpha: 1)
    })
    static let plum = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.77, green: 0.64, blue: 0.91, alpha: 1)
            : UIColor(red: 0.36, green: 0.20, blue: 0.52, alpha: 1)
    })

    static var background: Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.045, green: 0.055, blue: 0.052, alpha: 1)
                : UIColor(red: 0.955, green: 0.94, blue: 0.895, alpha: 1)
        })
    }

    static var card: Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.095, green: 0.115, blue: 0.105, alpha: 1)
                : UIColor(red: 1.00, green: 0.995, blue: 0.975, alpha: 1)
        })
    }

    static var softCard: Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.14, green: 0.16, blue: 0.15, alpha: 1)
                : UIColor(red: 0.91, green: 0.89, blue: 0.84, alpha: 1)
        })
    }

    static var hairline: Color {
        Color.primary.opacity(0.10)
    }

    static var separator: Color {
        Color(uiColor: .separator)
    }
}

struct PintPathRouteShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX - 24, y: rect.maxY * 0.82))
        path.addCurve(
            to: CGPoint(x: rect.maxX + 28, y: rect.maxY * 0.22),
            control1: CGPoint(x: rect.maxX * 0.23, y: rect.maxY * 0.92),
            control2: CGPoint(x: rect.maxX * 0.62, y: rect.maxY * 0.03)
        )
        return path
    }
}

struct PintPathBackdrop: View {
    var body: some View {
        GeometryReader { proxy in
            ZStack {
                BeerMapTheme.background
                PintPathRouteShape()
                    .stroke(
                        BeerMapTheme.amber.opacity(0.075),
                        style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [2, 10])
                    )
                    .frame(width: proxy.size.width * 1.2, height: min(proxy.size.height, 700))
                    .offset(x: -proxy.size.width * 0.05, y: -60)
                Circle()
                    .fill(BeerMapTheme.background)
                    .overlay(Circle().stroke(BeerMapTheme.amber.opacity(0.11), lineWidth: 2))
                    .frame(width: 12, height: 12)
                    .position(x: proxy.size.width * 0.72, y: min(proxy.size.height * 0.22, 170))
            }
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

struct PintPathTextFieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .padding(.horizontal, 14)
            .frame(minHeight: 50)
            .background(BeerMapTheme.card, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke(BeerMapTheme.separator.opacity(0.38), lineWidth: 1)
            )
    }
}

extension View {
    func beerMapCard(padding: CGFloat = 18) -> some View {
        self
            .padding(padding)
            .background(BeerMapTheme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(BeerMapTheme.hairline, lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.055), radius: 16, x: 0, y: 7)
    }

    func pintPathFloatingPanel(padding: CGFloat = 14) -> some View {
        self
            .padding(padding)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(Color.white.opacity(0.34), lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.14), radius: 18, x: 0, y: 8)
    }

    func readableForm() -> some View {
        self
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.done)
    }

    func beerMapScreen() -> some View {
        self
            .background(PintPathBackdrop())
            .scrollDismissesKeyboard(.interactively)
    }
}
