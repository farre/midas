Blog posts needs to be created in the `_posts` directory and named
according to the following format:

`YEAR-MONTH-DAY-title.MARKUP`

Jekyll also offers powerful support for code snippets:

{% highlight JavaScript %}
function helloWorld() {
  console.log("Hello, World!");
}
// => prints 'Hello, World!' to console.
{% endhighlight %}

Check out the [Jekyll docs][jekyll-docs] for more info on how to get
the most out of Jekyll

We use [utterances][utterances] to provide comments to the blog. To
add a comments section to a blog post, at the end of the post, add:

{% highlight liquid %}
{% raw %}{% include comments.html %}{% endraw %}
{% endhighlight %}

[Comments][comments] are created with a github label called comments. It is
perfectly fine to close a comment issue, since it will still be
possible to comment to it.

[jekyll-docs]: https://jekyllrb.com/docs/home
[comments]: https://github.com/farre/midas/issues?q=label%3Acomments
[utterances]: https://utteranc.es/
