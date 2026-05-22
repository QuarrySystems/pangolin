# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-05-22

### Added

- Initial MVP release with eleven packages:
  - `agora-core`: Core Agora runtime interfaces and types
  - `agora-client`: Client library for interacting with Agora
  - `agora-cli`: Command-line interface for Agora
  - `agora-mcp`: Model Context Protocol integration
  - `agora-worker`: Worker runtime for distributed execution
  - `agora-runtime-claude-code`: Claude Code runtime implementation
  - `agora-storage-s3`: AWS S3 storage provider
  - `agora-storage-local`: Local filesystem storage provider
  - `agora-providers-fargate`: AWS Fargate compute provider
  - `agora-providers-local-docker`: Local Docker compute provider
  - `agora-providers-aws-creds`: AWS credentials provider
- RuntimeAdapter seam with initial Claude Code implementation
- Full specification and design documentation
