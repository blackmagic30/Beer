import SwiftUI

enum BeerMapAsset {
    static let beerPint = "BeerPint"
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

struct SectionHeader: View {
    let eyebrow: String?
    let title: String
    let subtitle: String?
    var systemImage: String?
    var assetImage: String? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if assetImage != nil || systemImage != nil {
                Group {
                    if let assetImage {
                        Image(assetImage)
                            .renderingMode(.template)
                            .resizable()
                            .scaledToFit()
                            .padding(8)
                    } else if let systemImage {
                        Image(systemName: systemImage)
                            .font(.headline.weight(.semibold))
                    }
                }
                .foregroundStyle(BeerMapTheme.amber)
                .frame(width: 36, height: 36)
                .background(BeerMapTheme.amber.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityHidden(true)
            }

            VStack(alignment: .leading, spacing: 6) {
                if let eyebrow {
                    Text(eyebrow)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(BeerMapTheme.amber)
                        .accessibilityHidden(true)
                }
                Text(title)
                    .font(.title2.weight(.bold))
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
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: systemImage ?? (isError ? "exclamationmark.triangle.fill" : "checkmark.seal.fill"))
                .foregroundStyle(tint)
                .frame(width: 24)
            Text(message)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.11), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(tint.opacity(0.18), lineWidth: 1)
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
        HStack(spacing: 10) {
            Group {
                if let assetImage {
                    Image(assetImage)
                        .renderingMode(.template)
                        .resizable()
                        .scaledToFit()
                        .padding(8)
                } else {
                    Image(systemName: systemImage)
                        .font(.headline)
                }
            }
            .frame(width: 34, height: 34)
            .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .foregroundStyle(tint)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(value)
                    .font(.headline.weight(.bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 70)
        .padding(12)
        .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
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
            HStack {
                if isLoading {
                    ProgressView()
                        .tint(.secondary)
                } else {
                    Image(systemName: systemImage)
                }
                Text(title)
                    .fontWeight(.bold)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 50)
        }
        .buttonStyle(.plain)
        .foregroundStyle(isInteractive ? BeerMapTheme.primaryActionForeground : Color.secondary)
        .background(
            isInteractive ? BeerMapTheme.primaryAction : BeerMapTheme.softCard,
            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(isInteractive ? Color.clear : BeerMapTheme.separator.opacity(0.45), lineWidth: 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
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
            HStack {
                Image(systemName: systemImage)
                Text(title)
                    .fontWeight(.bold)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 48)
        }
        .buttonStyle(.plain)
        .foregroundStyle(isDestructive ? BeerMapTheme.danger : BeerMapTheme.primaryAction)
        .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
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
        VStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(BeerMapTheme.amber)
                .frame(width: 58, height: 58)
                .background(BeerMapTheme.honey.opacity(0.18), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            Text(title)
                .font(.headline.weight(.bold))
                .multilineTextAlignment(.center)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(isFramed ? 0 : 14)
        .background(isFramed ? Color.clear : BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 8))
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
                RoundedRectangle(cornerRadius: 8)
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
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .font(.headline.weight(.bold))
                .foregroundStyle(tint)
                .frame(width: 38, height: 38)
                .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
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
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(BeerMapTheme.hairline, lineWidth: 1)
        )
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
        VStack(alignment: .leading, spacing: 8) {
            Label(label, systemImage: systemImage)
                .font(.caption.weight(.bold))
                .foregroundStyle(.secondary)
            content
        }
        .padding(12)
        .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(BeerMapTheme.hairline, lineWidth: 1)
        )
    }
}

struct VenueCard: View {
    let venue: Venue
    var detail: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(venue.name)
                        .font(.headline.weight(.bold))
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(venue.displayLocation.isEmpty ? "Melbourne venue" : venue.displayLocation)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if venue.membershipTier == "pro" {
                    Text("Pro")
                        .font(.caption.weight(.black))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(BeerMapTheme.honey.opacity(0.24), in: Capsule())
                }
            }
            if let address = venue.address, !address.isEmpty {
                Label(address, systemImage: "mappin.and.ellipse")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let detail {
                Label(detail, systemImage: "location.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(BeerMapTheme.primaryAction)
            }
        }
        .beerMapCard()
        .accessibilityElement(children: .combine)
    }
}

struct LoadingOverlay: View {
    let message: String

    var body: some View {
        HStack(spacing: 10) {
            ProgressView()
                .tint(BeerMapTheme.amber)
            Text(message)
                .font(.subheadline.weight(.medium))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(BeerMapTheme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(BeerMapTheme.hairline, lineWidth: 1)
        )
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
                        .font(.caption2.weight(.bold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(
                            (isSelected ? BeerMapTheme.primaryActionForeground : BeerMapTheme.primaryAction).opacity(0.14),
                            in: Capsule()
                        )
                }
            }
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, 13)
            .frame(minHeight: 44)
        }
        .buttonStyle(.plain)
        .foregroundStyle(isSelected ? BeerMapTheme.primaryActionForeground : BeerMapTheme.primaryAction)
        .background(
            isSelected ? BeerMapTheme.primaryAction : BeerMapTheme.card,
            in: RoundedRectangle(cornerRadius: 13, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .stroke(isSelected ? Color.clear : BeerMapTheme.separator.opacity(0.45), lineWidth: 1)
        )
        .accessibilityLabel(badge.map { "\(title), \($0) active" } ?? title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
