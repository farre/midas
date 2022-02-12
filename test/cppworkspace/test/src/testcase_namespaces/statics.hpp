#pragma once
#include <string>
class Todo;
namespace statics
{
    struct Statics
    {
        int i;
        int j;

        Statics(int i, int j, std::string name) : i(i), j(j), m_name{std::move(name)} {}

        static int sk;
        static int *p_sk;
        static Todo stodo;
        static Todo *p_stodo;

        const std::string &get_name() const
        {
            return this->m_name;
        }

    private:
        std::string m_name;
    };

    void main();
} // namespace statics
