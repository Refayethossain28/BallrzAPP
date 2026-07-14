// ----------------------------------------------------------------------------
//  Apple Music bridge (MusicKit JS v3)
//  Lets the player stream music from their OWN Apple Music account during a race.
//
//  REQUIRES a MusicKit *developer token* (a JWT signed with your Apple Developer
//  MusicKit private key). It can't be faked — Apple Music will refuse to load
//  without a valid one. Supply it in ONE of these ways:
//    1) define  window.APPLE_MUSIC_DEV_TOKEN = '...'  before this script, or
//    2) paste it into the in-game "Apple Music" screen (stored in localStorage).
//  The user then signs in with their Apple Music subscription (authorize()).
// ----------------------------------------------------------------------------
(function(){
  const App = {
    configured: false,
    instance: null,
    get authorized(){ try { return !!(this.instance && this.instance.isAuthorized); } catch(e){ return false; } },

    sdkLoaded(){ return typeof window.MusicKit !== 'undefined'; },
    devToken(){
      if (window.APPLE_MUSIC_DEV_TOKEN) return window.APPLE_MUSIC_DEV_TOKEN;
      try { return localStorage.getItem('apple_music_dev_token') || ''; } catch(e){ return ''; }
    },
    setDevToken(t){ try { localStorage.setItem('apple_music_dev_token', (t||'').trim()); }catch(e){} this.configured=false; this.instance=null; },
    hasToken(){ return !!this.devToken(); },

    async configure(){
      if (this.configured && this.instance) return true;
      if (!this.sdkLoaded()) return false;
      const token = this.devToken(); if (!token) return false;
      try {
        await window.MusicKit.configure({ developerToken: token, app: { name: 'ApexGP', build: '1.0' } });
        this.instance = window.MusicKit.getInstance();
        this.configured = true;
        return true;
      } catch(e){ console.warn('[AppleMusic] configure failed', e); this.configured=false; return false; }
    },

    // returns {ok:true} or {ok:false, reason:'nosdk'|'notoken'|'denied'}
    async connect(){
      if (!this.hasToken()) return { ok:false, reason:'notoken' };
      if (!await this.configure()) return { ok:false, reason: this.sdkLoaded() ? 'notoken' : 'nosdk' };
      try { await this.instance.authorize(); return { ok:true }; }
      catch(e){ console.warn('[AppleMusic] authorize denied', e); return { ok:false, reason:'denied' }; }
    },

    // the player's own library playlists -> [{id,name}]
    async playlists(){
      if (!this.instance) return [];
      try {
        const r = await this.instance.api.music('/v1/me/library/playlists', { limit: 50 });
        const list = (r && r.data && r.data.data) || [];
        return list.map(p => ({ id: p.id, name: (p.attributes && p.attributes.name) || 'Playlist' }));
      } catch(e){ console.warn('[AppleMusic] playlists failed', e); return []; }
    },

    async playPlaylist(id){
      if (!this.instance || !id) return false;
      try { await this.instance.setQueue({ playlist: id }); await this.instance.play(); return true; }
      catch(e){ console.warn('[AppleMusic] playPlaylist failed', e); return false; }
    },
    pause(){  try { this.instance && this.instance.pause(); }catch(e){} },
    resume(){ try { this.instance && this.instance.play();  }catch(e){} },
    stop(){   try { this.instance && this.instance.stop();  }catch(e){} },
    next(){   try { this.instance && this.instance.skipToNextItem(); }catch(e){} },

    // search the Apple Music catalog for a song and loop it (used for the
    // built-in "named song" soundtrack cards, e.g. Buck Rogers by Feeder)
    async playSong(term){
      if (!this.instance || !term) return false;
      try {
        const sf = this.instance.storefrontId || 'us';
        const r = await this.instance.api.music('/v1/catalog/'+sf+'/search', { term, types:'songs', limit:1 });
        const hits = r && r.data && r.data.results && r.data.results.songs && r.data.results.songs.data;
        const song = hits && hits[0]; if (!song) return false;
        await this.instance.setQueue({ song: song.id });
        try { this.instance.repeatMode = window.MusicKit.PlayerRepeatMode.one; } catch(e){}
        await this.instance.play(); return true;
      } catch(e){ console.warn('[AppleMusic] playSong failed', e); return false; }
    },
    isPlaying(){ try { return !!(this.instance && this.instance.isPlaying); }catch(e){ return false; } },
    nowPlayingTitle(){
      try { const i=this.instance && this.instance.nowPlayingItem; return i ? (i.title || (i.attributes && i.attributes.name) || '') : ''; }
      catch(e){ return ''; }
    },
  };
  window.AppleMusic = App;
})();
