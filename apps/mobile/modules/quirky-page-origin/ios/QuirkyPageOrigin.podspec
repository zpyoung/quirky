Pod::Spec.new do |s|
  s.name = 'QuirkyPageOrigin'
  s.version = '1.0.0'
  s.summary = 'Verified Quirky mobile page bundle in an isolated native WebView origin'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'Lovecast Inc.'
  s.homepage = 'https://onorca.dev'
  s.source = { :git => 'https://github.com/stablyai/orca.git' }
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
