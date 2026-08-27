import SwiftUI

enum BeerMapAsset {
    static let beerPint = "BeerPint"
    static let beerPot = "BeerPot"
    static let beerSchooner = "BeerSchooner"
    static let beerJug = "BeerJug"
    static let pintPathLogo = "PintPathLogo"
    static let pintPathMark = "PintPathMark"
}

struct BeerPintIcon: View {
    var size: CGFloat = 18

    var body: some View {
        Image(BeerMapAsset.beerPint)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

struct PintPathMark: View {
    var size: CGFloat = 38

    var body: some View {
        Image(BeerMapAsset.pintPathMark)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .background(Color.white)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.26, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
                    .stroke(Color.black.opacity(0.08), lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.09), radius: size * 0.12, x: 0, y: size * 0.07)
            .accessibilityHidden(true)
    }
}

struct PintPathBrandLockup: View {
    var compact = false

    var body: some View {
        Image(BeerMapAsset.pintPathLogo)
            .resizable()
            .scaledToFit()
            .frame(width: compact ? 96 : 126, height: compact ? 40 : 58)
            .background(Color.white)
            .clipShape(RoundedRectangle(cornerRadius: compact ? 10 : 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: compact ? 10 : 14, style: .continuous)
                    .stroke(Color.black.opacity(0.07), lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.07), radius: 5, x: 0, y: 3)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Pint Path, Melbourne pub guide")
    }
}

struct PintPathHero: View {
    let eyebrow: String?
    let title: String
    let subtitle: String?
    var systemImage: String? = nil
    var assetImage: String? = nil

    var body: some View {
        ZStack(alignment: .topTrailing) {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(BeerMapTheme.brandInk)

            PintPathRouteShape()
                .stroke(
                    BeerMapTheme.brandGold.opacity(0.38),
                    style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [2, 8])
                )
                .frame(width: 220, height: 130)
                .offset(x: 42, y: -12)
                .accessibilityHidden(true)

            Circle()
                .fill(BeerMapTheme.brandInk)
                .overlay(Circle().stroke(BeerMapTheme.brandGold, lineWidth: 2))
                .frame(width: 13, height: 13)
                .offset(x: -53, y: 45)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .center) {
                    if let eyebrow {
                        Text(eyebrow.uppercased())
                            .font(.system(size: 10, weight: .black))
                            .tracking(1.45)
                            .foregroundStyle(BeerMapTheme.brandGold)
                    }
                    Spacer(minLength: 12)
                    Group {
                        if let assetImage {
                            Image(assetImage)
                                .renderingMode(.template)
                                .resizable()
                                .scaledToFit()
                                .padding(9)
                        } else if let systemImage {
                            Image(systemName: systemImage)
                                .font(.headline.weight(.bold))
                        } else {
                            BeerPintIcon(size: 19)
                        }
                    }
                    .foregroundStyle(BeerMapTheme.brandInk)
                    .frame(width: 38, height: 38)
                    .background(BeerMapTheme.brandGold, in: Circle())
                    .accessibilityHidden(true)
                }

                Text(title)
                    .font(.system(.title, design: .serif, weight: .bold))
                    .foregroundStyle(BeerMapTheme.paper)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)

                if let subtitle {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(BeerMapTheme.paper.opacity(0.74))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(20)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.17), radius: 18, x: 0, y: 9)
        .accessibilityElement(children: .contain)
    }
}

struct SectionHeader: View {
    let eyebrow: String?
    let title: String
    let subtitle: String?
    var systemImage: String?
    var assetImage: String? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 13) {
            VStack(spacing: 5) {
                ZStack {
                    Circle()
                        .fill(BeerMapTheme.brandGold)
                    Group {
                        if let assetImage {
                            Image(assetImage)
                                .renderingMode(.template)
                                .resizable()
                                .scaledToFit()
                                .padding(8)
                        } else if let systemImage {
                            Image(systemName: systemImage)
                                .font(.caption.weight(.black))
                        } else {
                            Circle()
                                .fill(BeerMapTheme.brandInk)
                                .frame(width: 7, height: 7)
                        }
                    }
                    .foregroundStyle(BeerMapTheme.brandInk)
                }
                .frame(width: 31, height: 31)

                Capsule()
                    .fill(BeerMapTheme.brandGold.opacity(0.45))
                    .frame(width: 2, height: subtitle == nil ? 13 : 24)
            }
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 6) {
                if let eyebrow {
                    Text(eyebrow.uppercased())
                        .font(.system(size: 10, weight: .black))
                        .tracking(1.25)
                        .foregroundStyle(BeerMapTheme.amber)
                        .accessibilityHidden(true)
                }
                Text(title)
                    .font(.system(.title2, design: .serif, weight: .bold))
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if let subtitle {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }
}

struct StatusBanner: View {
    let message: String
    var isError = false
    var systemImage: String?

    private var tint: Color {
        isError ? BeerMapTheme.danger : BeerMapTheme.leaf
    }

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: systemImage ?? (isError ? "exclamationmark.triangle.fill" : "checkmark.seal.fill"))
                .font(.subheadline.weight(.bold))
                .foregroundStyle(tint)
                .frame(width: 24)
            Text(message)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 13)
        .padding(.leading, 15)
        .padding(.trailing, 13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(BeerMapTheme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(alignment: .leading) {
            Capsule()
                .fill(tint)
                .frame(width: 4)
                .padding(.vertical, 9)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(tint.opacity(0.17), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }
}

struct MetricPill: View {
    let title: String
    let value: String
    var systemImage: String = "chart.bar.fill"
    var assetImage: String? = nil
    var tint: Color = BeerMapTheme.sky

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Group {
                    if let assetImage {
                        Image(assetImage)
                            .renderingMode(.template)
                            .resizable()
                            .scaledToFit()
                            .padding(6)
                    } else {
                        Image(systemName: systemImage)
                            .font(.caption.weight(.bold))
                    }
                }
                .frame(width: 28, height: 28)
                .foregroundStyle(tint)
                Spacer(minLength: 0)
                Capsule()
                    .fill(tint)
                    .frame(width: 22, height: 3)
            }
            Text(value)
                .font(.system(.title2, design: .rounded, weight: .bold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.72)
            Text(title.uppercased())
                .font(.system(size: 9, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, minHeight: 94, alignment: .leading)
        .padding(13)
        .background(BeerMapTheme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(BeerMapTheme.hairline, lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }
}

struct PrimaryButton: View {
    @Environment(\.isEnabled) private var isEnabled

    let title: String
    let systemImage: String
    let isLoading: Bool
    let action: () -> Void

    private var isInteractive: Bool {
        isEnabled && !isLoading
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 11) {
                ZStack {
                    Circle()
                        .fill(isInteractive ? BeerMapTheme.brandGold : Color.secondary.opacity(0.14))
                    if isLoading {
                        ProgressView()
                            .tint(BeerMapTheme.brandInk)
                            .controlSize(.small)
                    } else {
                        Image(systemName: systemImage)
                            .font(.subheadline.weight(.black))
                            .foregroundStyle(isInteractive ? BeerMapTheme.brandInk : Color.secondary)
                    }
                }
                .frame(width: 32, height: 32)

                Text(title)
                    .font(.headline.weight(.bold))
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if !isLoading {
                    Image(systemName: "arrow.right")
                        .font(.caption.weight(.black))
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 56)
        }
        .buttonStyle(.plain)
        .foregroundStyle(isInteractive ? BeerMapTheme.primaryActionForeground : Color.secondary)
        .background(
            isInteractive ? BeerMapTheme.primaryAction : BeerMapTheme.softCard,
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(isInteractive ? Color.white.opacity(0.08) : BeerMapTheme.separator.opacity(0.35), lineWidth: 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .disabled(isLoading || !isEnabled)
        .accessibilityLabel(title)
        .accessibilityValue(isLoading ? "In progress" : "")
    }
}

struct SecondaryButton: View {
    let title: String
    let systemImage: String
    var isDestructive = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: systemImage)
                    .font(.subheadline.weight(.bold))
                Text(title)
                    .font(.subheadline.weight(.bold))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 13)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 50)
        }
        .buttonStyle(.plain)
        .foregroundStyle(isDestructive ? BeerMapTheme.danger : BeerMapTheme.primaryAction)
        .background(BeerMapTheme.card, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .stroke((isDestructive ? BeerMapTheme.danger : BeerMapTheme.primaryAction).opacity(0.22), lineWidth: 1)
        )
        .accessibilityLabel(title)
    }
}

struct EmptyStateView: View {
    let title: String
    let message: String
    let systemImage: String
    var isFramed = true

    var body: some View {
        VStack(spacing: 13) {
            ZStack {
                Circle()
                    .stroke(BeerMapTheme.brandGold.opacity(0.42), style: StrokeStyle(lineWidth: 2, dash: [2, 5]))
                Image(systemName: systemImage)
                    .font(.system(size: 25, weight: .bold))
                    .foregroundStyle(BeerMapTheme.amber)
            }
            .frame(width: 58, height: 58)
            Text(title)
                .font(.system(.headline, design: .serif, weight: .bold))
                .multilineTextAlignment(.center)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(isFramed ? 0 : 15)
        .background(isFramed ? Color.clear : BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .modifier(CardFrameModifier(isFramed: isFramed))
        .accessibilityElement(children: .combine)
    }
}

private struct CardFrameModifier: ViewModifier {
    let isFramed: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if isFramed {
            content.beerMapCard()
        } else {
            content.overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(BeerMapTheme.hairline, lineWidth: 1)
            )
        }
    }
}

struct FeatureCard: View {
    let title: String
    let message: String
    let systemImage: String
    var tint: Color = BeerMapTheme.amber

    var body: some View {
        HStack(alignment: .top, spacing: 13) {
            Image(systemName: systemImage)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(tint)
                .frame(width: 26, alignment: .leading)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline.weight(.bold))
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(BeerMapTheme.hairline)
                .frame(height: 1)
        }
        .accessibilityElement(children: .combine)
    }
}

struct FormFieldShell<Content: View>: View {
    let label: String
    let systemImage: String
    let content: Content

    init(label: String, systemImage: String, @ViewBuilder content: () -> Content) {
        self.label = label
        self.systemImage = systemImage
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                    .foregroundStyle(BeerMapTheme.amber)
                Text(label.uppercased())
                    .tracking(0.75)
            }
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(.secondary)
            content
        }
    }
}

struct VenueCard: View {
    let venue: Venue
    var detail: String? = nil

    var body: some View {
        HStack(alignment: .center, spacing: 13) {
            ZStack {
                Circle()
                    .fill(BeerMapTheme.brandGold)
                BeerPintIcon(size: 18)
                    .foregroundStyle(BeerMapTheme.brandInk)
            }
            .frame(width: 40, height: 40)

            VStack(alignment: .leading, spacing: 4) {
                Text(venue.name)
                    .font(.system(.headline, design: .serif, weight: .bold))
                    .lineLimit(2)
                Text(venue.displayLocation.isEmpty ? "Melbourne venue" : venue.displayLocation)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let detail {
                    Text(detail)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(BeerMapTheme.amber)
                } else if let address = venue.address, !address.isEmpty {
                    Text(address)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .beerMapCard(padding: 14)
        .accessibilityElement(children: .combine)
    }
}

struct LoadingOverlay: View {
    let message: String

    var body: some View {
        HStack(spacing: 11) {
            ProgressView()
                .tint(BeerMapTheme.amber)
            Text(message)
                .font(.subheadline.weight(.semibold))
        }
        .padding(.horizontal, 17)
        .frame(minHeight: 50)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().stroke(Color.white.opacity(0.32), lineWidth: 1))
        .shadow(color: Color.black.opacity(0.12), radius: 14, x: 0, y: 6)
        .accessibilityElement(children: .combine)
    }
}

struct FilterChip: View {
    let title: String
    var systemImage: String? = nil
    var assetImage: String? = nil
    var isSelected = false
    var badge: Int?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                if let assetImage {
                    Image(assetImage)
                        .renderingMode(.template)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 17, height: 17)
                        .accessibilityHidden(true)
                } else if let systemImage {
                    Image(systemName: systemImage)
                        .accessibilityHidden(true)
                }
                Text(title)
                    .lineLimit(1)
                if let badge, badge > 0 {
                    Text("\(badge)")
                        .font(.caption2.weight(.black))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(
                            (isSelected ? BeerMapTheme.brandInk : BeerMapTheme.amber).opacity(0.12),
                            in: Capsule()
                        )
                }
            }
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
        }
        .buttonStyle(.plain)
        .foregroundStyle(isSelected ? BeerMapTheme.brandInk : BeerMapTheme.primaryAction)
        .background(
            isSelected ? BeerMapTheme.brandGold : BeerMapTheme.card,
            in: Capsule()
        )
        .overlay(
            Capsule()
                .stroke(isSelected ? BeerMapTheme.brandInk.opacity(0.08) : BeerMapTheme.separator.opacity(0.38), lineWidth: 1)
        )
        .accessibilityLabel(badge.map { "\(title), \($0) active" } ?? title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
