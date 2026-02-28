// @ts-check
/**
 * News Feed Module
 * Fetches RSS feeds for market context
 */

const RSS_FEEDS = {
  crypto: {
    url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
    name: 'CoinDesk'
  },
  kraken: {
    url: 'https://blog.kraken.com/feed',
    name: 'Kraken Blog'
  },
  world: {
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    name: 'BBC World'
  }
};

function parseRSS(xmlText, maxItems = 5) {
  const items = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  
  let match;
  while ((match = itemRegex.exec(xmlText)) !== null && items.length < maxItems) {
    const itemXml = match[1];
    
    const titleMatch = itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/i);
    const title = titleMatch ? (titleMatch[1] || titleMatch[2]) : '';
    
    const pubDateMatch = itemXml.match(/<pubDate>(.*?)<\/pubDate>/i);
    const pubDate = pubDateMatch ? pubDateMatch[1] : '';
    
    if (title) {
      const age = getAgeString(pubDate);
      items.push({
        title: title.trim(),
        age
      });
    }
  }
  
  return items;
}

function getAgeString(pubDate) {
  if (!pubDate) return '';
  
  try {
    const date = new Date(pubDate);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return '';
  } catch (e) {
    return '';
  }
}

async function fetchFeed(feedKey) {
  const feed = RSS_FEEDS[feedKey];
  if (!feed) return { feed: feedKey, items: [], error: 'Unknown feed' };
  
  try {
    const response = await fetch(feed.url, {
      headers: {
        'User-Agent': 'KrakenBot/2.0',
        'Accept': 'application/rss+xml, application/xml, text/xml'
      },
      timeout: 10000
    });
    
    if (!response.ok) {
      return { feed: feedKey, items: [], error: `HTTP ${response.status}` };
    }
    
    const xmlText = await response.text();
    const items = parseRSS(xmlText, 5);
    
    return { feed: feedKey, name: feed.name, items };
  } catch (error) {
    return { feed: feedKey, items: [], error: error.message };
  }
}

async function fetchAllNews() {
  const [crypto, kraken, world] = await Promise.all([
    fetchFeed('crypto'),
    fetchFeed('kraken'),
    fetchFeed('world')
  ]);
  
  return { crypto, kraken, world };
}

function formatNewsForPrompt(news) {
  const lines = [];
  
  if (news.crypto?.items?.length > 0) {
    lines.push('[CRYPTO NEWS]');
    news.crypto.items.forEach(item => {
      lines.push(`  ${item.title}${item.age ? ` (${item.age})` : ''}`);
    });
  }
  
  if (news.kraken?.items?.length > 0) {
    lines.push('[KRAKEN UPDATES]');
    news.kraken.items.forEach(item => {
      lines.push(`  ${item.title}${item.age ? ` (${item.age})` : ''}`);
    });
  }
  
  if (news.world?.items?.length > 0) {
    lines.push('[WORLD NEWS]');
    news.world.items.forEach(item => {
      lines.push(`  ${item.title}${item.age ? ` (${item.age})` : ''}`);
    });
  }
  
  return lines.join('\n');
}

module.exports = {
  fetchAllNews,
  fetchFeed,
  formatNewsForPrompt
};