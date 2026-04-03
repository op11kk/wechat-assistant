// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "IOSBehindAPI",
    platforms: [
        .iOS(.v15),
        .macOS(.v12),
    ],
    products: [
        .library(name: "IOSBehindAPI", targets: ["IOSBehindAPI"]),
    ],
    targets: [
        .target(
            name: "IOSBehindAPI",
            path: "swift",
            sources: ["IOSBehindAPI.swift"]
        ),
    ]
)
