import SwiftUI

/// ApexVIP brand design system — mirrors the web app's CSS variables.
enum Brand {
    // Core palette
    static let gold      = Color(hex: 0xD4A843)
    static let goldDeep  = Color(hex: 0x8B6914)
    static let bg        = Color(hex: 0x0A0A0A)
    static let bgDeep    = Color(hex: 0x050505)
    static let surface   = Color(hex: 0x16140F)
    static let surface2  = Color(hex: 0x1F1C16)
    static let border    = Color.white.opacity(0.10)
    static let divider   = Color.white.opacity(0.07)

    // Text
    static let fg   = Color.white
    static let fg2  = Color.white.opacity(0.72)
    static let fg3  = Color.white.opacity(0.50)
    static let fg4  = Color.white.opacity(0.35)

    static let green = Color(hex: 0x22C55E)
    static let red   = Color(hex: 0xEF4444)

    // Serif display face for the wordmark (New York via .serif design).
    static func serif(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .serif)
    }
}

extension Color {
    init(hex: UInt, alpha: Double = 1.0) {
        self.init(
            .sRGB,
            red:   Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8)  & 0xff) / 255,
            blue:  Double(hex & 0xff) / 255,
            opacity: alpha
        )
    }
}

// MARK: - Reusable styles

/// A dark rounded card matching the web `.card`.
struct Card<Content: View>: View {
    var padding: CGFloat = 20
    @ViewBuilder var content: Content
    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Brand.surface)
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(Brand.border, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 20))
    }
}

/// Primary gold button matching `.btn-gold`.
struct GoldButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .bold))
            .foregroundStyle(Brand.bgDeep)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(Brand.gold)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .opacity(configuration.isPressed ? 0.85 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// Translucent secondary button matching `.btn-glass`.
struct GlassButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(Brand.fg)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(Brand.surface2)
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Brand.border, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

/// Uppercase tracked section label matching `.section-label`.
struct SectionLabel: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 11, weight: .bold))
            .tracking(1.5)
            .foregroundStyle(Brand.fg4)
    }
}
