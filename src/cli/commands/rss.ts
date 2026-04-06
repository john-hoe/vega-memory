import { Command } from "commander";

import { RSSService } from "../../ingestion/rss.js";

export function registerRSSCommands(program: Command, rssService: RSSService): void {
  const rssCommand = program.command("rss").description("Manage RSS feeds");

  rssCommand
    .command("add")
    .description("Add an RSS or Atom feed")
    .argument("<feed_url>", "feed URL")
    .option("--project <project>", "project name")
    .option("--json", "print JSON")
    .action(async (feedUrl: string, options: { project?: string; json?: boolean }) => {
      const result = await rssService.addFeed(feedUrl, options.project);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`${result.id} ${JSON.stringify(result.title)}`);
    });

  rssCommand
    .command("list")
    .description("List active RSS feeds")
    .option("--json", "print JSON")
    .action((options: { json?: boolean }) => {
      const feeds = rssService.listFeeds();

      if (options.json) {
        console.log(JSON.stringify(feeds, null, 2));
        return;
      }

      if (feeds.length === 0) {
        console.log("No RSS feeds found.");
        return;
      }

      console.table(
        feeds.map((feed) => ({
          id: feed.id,
          title: feed.title,
          url: feed.url,
          project: feed.project ?? "global",
          last_polled_at: feed.last_polled_at,
          last_entry_at: feed.last_entry_at
        }))
      );
    });

  rssCommand
    .command("remove")
    .description("Remove an RSS feed")
    .argument("<feed_id>", "feed ID")
    .option("--json", "print JSON")
    .action((feedId: string, options: { json?: boolean }) => {
      rssService.removeFeed(feedId);

      if (options.json) {
        console.log(JSON.stringify({ removed: true, id: feedId }, null, 2));
        return;
      }

      console.log(feedId);
    });
}
