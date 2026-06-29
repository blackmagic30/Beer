import SwiftUI

struct SectionHeader: View {
    let eyebrow: String?
    let title: String
    let subtitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let eyebrow {
                Text(eyebrow.uppercased())
                    .font(.caption.weight(.black))
                    .foregroundStyle(BeerMapTheme.amber)
                    .accessibilityHidden(true)
            }
            Text(title)
                .font(.title2.weight(.bold))
                .foregroundStyle(.primary)
            if let subtitle {
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct StatusBanner: View {
    let message: String
    var isError = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: isError ? "exclamationmark.triangle.fill" : "checkmark.seal.fill")
                .foregroundStyle(isError ? .red : BeerMapTheme.leaf)
            Text(message)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background((isError ? Color.red : BeerMapTheme.leaf).opacity(0.11), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
    }
}

struct MetricPill: View {
    let title: String
    let value: String
    var systemImage: String = "chart.bar.fill"
    var tint: Color = BeerMapTheme.sky

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.headline)
                .frame(width: 30, height: 30)
                .background(tint.opacity(0.14), in: Circle())
                .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(value)
                    .font(.headline.weight(.bold))
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

struct PrimaryButton: View {
    let title: String
    let systemImage: String
    let isLoading: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                if isLoading {
                    ProgressView()
                        .tint(.white)
                } else {
                    Image(systemName: systemImage)
                }
                Text(title)
                    .fontWeight(.bold)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.white)
        .background(BeerMapTheme.ink, in: RoundedRectangle(cornerRadius: 8))
        .disabled(isLoading)
        .accessibilityLabel(title)
    }
}

struct EmptyStateView: View {
    let title: String
    let message: String
    let systemImage: String

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(BeerMapTheme.amber)
            Text(title)
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .beerMapCard()
        .accessibilityElement(children: .combine)
    }
}

struct VenueCard: View {
    let venue: Venue

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(venue.name)
                        .font(.headline.weight(.bold))
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
        }
        .beerMapCard()
    }
}

struct LoadingOverlay: View {
    let message: String

    var body: some View {
        HStack(spacing: 10) {
            ProgressView()
            Text(message)
                .font(.subheadline.weight(.medium))
        }
        .padding(12)
        .background(.regularMaterial, in: Capsule())
        .shadow(radius: 12)
    }
}

