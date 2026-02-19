-- Alpha Channel Media - PostgreSQL Schema
-- Run this file against your database to create all tables

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Creators table
CREATE TABLE IF NOT EXISTS creators (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    pin_hash VARCHAR(255),
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    artist_name VARCHAR(100),
    bio TEXT,
    listener_key VARCHAR(4),
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW()
);

-- Listeners table
CREATE TABLE IF NOT EXISTS listeners (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email_notifications BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Applications table
CREATE TABLE IF NOT EXISTS applications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    username VARCHAR(50) NOT NULL,
    artist_name VARCHAR(100),
    bio TEXT,
    reason TEXT,
    status VARCHAR(20) DEFAULT 'pending',
    submitted_at TIMESTAMP DEFAULT NOW(),
    processed_at TIMESTAMP
);

-- Songs table
CREATE TABLE IF NOT EXISTS songs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    creator_id UUID REFERENCES creators(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    artist VARCHAR(255) NOT NULL,
    lyrics TEXT,
    audio_url TEXT NOT NULL,
    artwork_url TEXT,
    file_size BIGINT,
    duration INTEGER,
    format VARCHAR(20),
    bitrate INTEGER,
    uploaded_at TIMESTAMP DEFAULT NOW()
);

-- Videos table
CREATE TABLE IF NOT EXISTS videos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    creator_id UUID REFERENCES creators(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(50),
    video_url TEXT NOT NULL,
    thumbnail_url TEXT,
    file_size BIGINT,
    duration INTEGER,
    resolution VARCHAR(20),
    format VARCHAR(20),
    uploaded_at TIMESTAMP DEFAULT NOW()
);

-- Persistent listener-creator access
CREATE TABLE IF NOT EXISTS listener_creator_access (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    listener_id UUID NOT NULL REFERENCES listeners(id) ON DELETE CASCADE,
    creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    granted_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(listener_id, creator_id)
);

-- Listener-creator email subscriptions
CREATE TABLE IF NOT EXISTS listener_creator_subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    listener_id UUID NOT NULL REFERENCES listeners(id) ON DELETE CASCADE,
    creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    email_on_upload BOOLEAN DEFAULT true,
    subscribed_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(listener_id, creator_id)
);

-- Email notification log
CREATE TABLE IF NOT EXISTS email_notifications_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    listener_id UUID REFERENCES listeners(id) ON DELETE SET NULL,
    creator_id UUID REFERENCES creators(id) ON DELETE SET NULL,
    email_type VARCHAR(50) NOT NULL,
    subject TEXT,
    sent_at TIMESTAMP DEFAULT NOW(),
    status VARCHAR(20) DEFAULT 'sent'
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_songs_creator_id ON songs(creator_id);
CREATE INDEX IF NOT EXISTS idx_videos_creator_id ON videos(creator_id);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_songs_uploaded_at ON songs(uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_uploaded_at ON videos(uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_listener_creator_access_listener ON listener_creator_access(listener_id);
CREATE INDEX IF NOT EXISTS idx_listener_creator_access_creator ON listener_creator_access(creator_id);
CREATE INDEX IF NOT EXISTS idx_listener_creator_subs_listener ON listener_creator_subscriptions(listener_id);
CREATE INDEX IF NOT EXISTS idx_listener_creator_subs_creator ON listener_creator_subscriptions(creator_id);
CREATE INDEX IF NOT EXISTS idx_email_log_listener ON email_notifications_log(listener_id);
CREATE INDEX IF NOT EXISTS idx_email_log_sent_at ON email_notifications_log(sent_at DESC);
